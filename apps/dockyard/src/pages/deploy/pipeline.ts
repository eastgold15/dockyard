// 部署六阶段流水线：Source → Build → Artifact → Ship → Run → Expose。
//
// 坐标系设计（见 apps/docs/docs/部署抽象.md）：
// - 前半段（源×构建×传输）按形态自由组合，由 forms.ts 的 provision 实现；
// - 零界点 = Artifact：「远端工作目录就绪 + 镜像在目标 docker 守护进程就绪」；
// - 后半段对坐标无关，收敛为共享 activate（preflight → up → edge 对账）+ captureArtifact；
// - 回滚 = 激活旧产物（activateArtifact），与正常部署共用 Run/Expose 语义。
// 逻辑库不穿零点（无产物），由 forms.ts 的 custom run 旁路承接。
import { ServiceError } from "@elysiax/core";
import { openSftp } from "@meitaim/ssh/sftp";
import type { SshClient } from "@meitaim/ssh";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import type { AppPaths } from "../../shared/paths";
import type { CanvasService } from "../canvas/canvas.socket";
import type { EdgeService } from "../edge/edge.socket";
import type { GithubService } from "../github/github.socket";
import type { ProjectService } from "../projects/projects.socket";
import type { ServerService } from "../servers/servers.socket";
import type { DeployRepository } from "./deploy.repository";
import { envFilePaths } from "./detect";
import type { DeployArtifact, Deployment, DeployTarget } from "./schema";

export type Log = (line: string) => Promise<void>;
export type SetStatus = (s: Deployment["status"], p?: Partial<Deployment>) => Promise<unknown>;

/** 阶段上下文：一次部署运行里所有阶段共享的句柄 */
export interface StageCtx {
  target: DeployTarget;
  run: Deployment;
  log: Log;
  setStatus: SetStatus;
}

/**
 * 前半段（源→构建→传输）的产物：零界点断言的实现证据。
 * provision 返回它时，「远端目录就绪 + 镜像就绪」必须已经成立。
 */
export interface Provision {
  /** 远端工作目录（compose 文件已就位；github 路径 = 远端检出目录） */
  remoteDir: string;
  /** compose 项目名（cfg.name ?? dockyard-<id>）；db 模板不设（沿用目录名，与历史行为一致） */
  project?: string;
  /** preflight 对账的容器名清单 */
  containerNames: string[];
  /** 有则在 captureArtifact 里打 run tag（db 模板用官方镜像，无） */
  services?: Record<string, { image?: string }>;
  /** up 的 -f 参数段（含引号，逐字拼进 shell），空 = compose 默认发现 */
  composeArgs: string;
  /** 实际 up 的服务子集（共享资源复用过滤中间件；undefined = 全量） */
  upServices?: string[];
  /** 源码版本（github 短 sha / local 短 sha）；有则回写 lastKnownSha 并进产物 */
  sha?: string;
  /** 产物快照原料（captureArtifact 加密落 deploy_artifacts） */
  snapshot: { compose: string; override: string; env: string };
}

/** 部署形态：compose 形态实现 provision 走共享骨架；custom（逻辑库）全程自控 */
export interface DeployForm {
  name: string;
  provision?(ctx: StageCtx, h: Harness): Promise<Provision>;
  run?(ctx: StageCtx, h: Harness): Promise<void>;
}

type SshExecResult = Awaited<ReturnType<SshClient["exec"]>>;

/** 服务器能力清单（雏形：本轮只有 arch 探测 + 内存缓存；将来登记更多能力/落库） */
export interface ServerCaps {
  /** docker 架构名（amd64/arm64/…），本地构建跨平台时用 */
  arch: string;
}

/** 形态实现可用的全部外部能力（service 构造时经 createHarness 装配） */
export interface Harness {
  repo: DeployRepository;
  serverService: ServerService;
  edge: EdgeService;
  github: GithubService;
  canvas: CanvasService;
  project: ProjectService;
  paths: AppPaths;
  /** 带断线重连的短命令 */
  sshExec(serverId: number, cmd: string, retries?: number): Promise<SshExecResult>;
  /** 长跑命令远端后台执行 + 轮询日志（防 SIGHUP） */
  execLongRemote(serverId: number, cmd: string, tag: string, log: Log): Promise<{ code: number }>;
  serverCaps(serverId: number): Promise<ServerCaps>;
  /** SFTP 不做 shell 展开，`~` 先解析成绝对路径 */
  resolveRemoteDir(client: SshClient, dir: string): Promise<string>;
  /** 部署前对账：远端同名容器归属校验，绝不动别人的容器 */
  preflightCheck(target: DeployTarget, serverId: number, containerNames: string[], log: Log): Promise<void>;
  /** target → node → serverId */
  nodeServerId(target: DeployTarget): Promise<number>;
}

/** 流式执行本地命令，输出写入部署日志；env 用于注入 DOCKER_DEFAULT_PLATFORM 等覆盖 */
export async function run(cmd: string[], cwd: string, log: Log, env?: Record<string, string>): Promise<void> {
  log(`$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : undefined });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) await log(new TextDecoder().decode(chunk).trimEnd());
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  if (code !== 0) throw new ServiceError(`命令失败（exit ${code}）: ${cmd.join(" ")}`);
}

/** uname -m / process.arch → docker 架构名 */
export function dockerArch(raw: string): string {
  const r = raw.trim().toLowerCase();
  if (r === "x86_64" || r === "amd64" || r === "x64") return "amd64";
  if (r === "aarch64" || r === "arm64") return "arm64";
  if (r.startsWith("armv7")) return "arm/v7";
  return r;
}

export function createHarness(deps: {
  repo: DeployRepository;
  serverService: ServerService;
  edge: EdgeService;
  github: GithubService;
  canvas: CanvasService;
  project: ProjectService;
  paths: AppPaths;
}): Harness {
  const { serverService, canvas } = deps;
  /** serverId → docker 架构名（内存缓存——硬件不会中途变） */
  const archCache = new Map<number, string>();

  /** 带断线重连的短命令：连接失效则丢弃缓存重建后重试 */
  const sshExec = async (serverId: number, cmd: string, retries = 2): Promise<SshExecResult> => {
    for (;;) {
      try {
        return await (await serverService.ssh(serverId)).exec(cmd);
      } catch (error) {
        if (retries-- <= 0) throw error;
        await serverService.dropSsh(serverId);
      }
    }
  };

  /**
   * 长跑命令（镜像构建）放远端后台执行 + 轮询日志文件：
   * 单条 exec 挂几十分钟会被中间网络/sshd 断开，通道一关命令就被 SIGHUP 杀掉；
   * nohup 后台 + 短轮询则断线只废掉一次轮询，重连后续跑，构建本体不受影响。
   */
  const execLongRemote = async (
    serverId: number,
    cmd: string,
    tag: string,
    log: Log,
  ): Promise<{ code: number }> => {
    const logFile = `/tmp/dockyard-long-${tag}.log`;
    const codeFile = `${logFile}.code`;
    const partFile = `${logFile}.part`;
    const quoted = cmd.replace(/'/g, `'\\''`);
    const start = await sshExec(
      serverId,
      // < /dev/null 必须：后台进程继承通道 stdin 会让 sshd 一直等 EOF，start 命令挂到构建结束才返回
      `rm -f ${logFile} ${codeFile} ${partFile} && nohup sh -c '${quoted}; echo $? > ${codeFile}' > ${logFile} 2>&1 < /dev/null & echo started`,
    );
    if (start.code !== 0) throw new ServiceError(`远端后台命令启动失败：${start.stderr}`);
    let offset = 0;
    let delay = 4_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, delay));
      delay = 4_000;
      let res: SshExecResult;
      try {
        res = await sshExec(
          serverId,
          // 窗口读取：每轮最多 256KB——构建日志可达数 MB，弱网下全量重传必然反复失败（偏移不涨、越传越大）
          // 服务端报告本次实际输出字节数，避免客户端按解码后字符串估算偏移踩 UTF-8 边界
          `tail -c +${offset + 1} ${logFile} 2>/dev/null | head -c 262144 > ${partFile}; cat ${partFile};` +
            `printf '\\n__DC_SIZE__\\n'; wc -c < ${partFile}; printf '__DC_CODE__\\n'; cat ${codeFile} 2>/dev/null || true`,
          0,
        );
      } catch {
        await serverService.dropSsh(serverId); // 本轮轮询撞上断线：重建连接下轮续跑
        continue;
      }
      const [rest = "", codeText = ""] = res.stdout.split("__DC_CODE__\n");
      const [chunk = "", sizeText = "0"] = rest.split("\n__DC_SIZE__\n");
      const printed = Number(sizeText.trim());
      if (Number.isFinite(printed) && printed > 0) {
        offset += printed;
        if (chunk) await log(chunk.trimEnd());
        if (printed >= 262144) delay = 300; // 读满窗口说明积压严重，加速排空
      }
      const codeStr = codeText.trim();
      // 命令已结束但日志还有积压时继续排空（失败上下文在文件尾部），printed==0 说明已追到 EOF
      if (codeStr !== "" && (!Number.isFinite(printed) || printed === 0)) {
        const code = Number(codeStr);
        return { code: Number.isFinite(code) ? code : -1 };
      }
    }
  };

  return {
    ...deps,
    sshExec,
    execLongRemote,
    async serverCaps(serverId) {
      let arch = archCache.get(serverId);
      if (!arch) {
        const r = await sshExec(serverId, "uname -m");
        arch = dockerArch(r.stdout);
        archCache.set(serverId, arch);
      }
      return { arch };
    },
    async resolveRemoteDir(client, dir) {
      if (!dir.startsWith("~")) return dir;
      const { stdout } = await client.exec('printf %s "$HOME"');
      return `${stdout.trim()}${dir.slice(1)}`;
    },
    async preflightCheck(target, serverId, containerNames, log) {
      const remote = await serverService.docker(serverId);
      const containers = await remote.listContainers({ all: true });
      for (const name of containerNames) {
        const hit = containers.find((c) => c.Names.includes(`/${name}`));
        if (!hit) continue;
        const managed = hit.Labels?.["dockyard.managed"] === "true";
        const owner = hit.Labels?.["dockyard.target-id"];
        if (managed && owner === String(target.id)) {
          await log(`复用已有容器 ${name}（本工具管理）`);
          continue;
        }
        throw new ServiceError(
          managed
            ? `远端容器 ${name} 属于另一个部署目标（#${owner}），已阻止部署`
            : `远端已存在非本工具管理的同名容器 ${name}，已阻止部署——请改名，或手动处理远端容器`,
        );
      }
    },
    async nodeServerId(target) {
      const node = await canvas.byId(target.nodeId);
      if (!node) throw new ServiceError("画布节点已删除");
      return node.serverId;
    },
  };
}

// ── 执行器：形态分派 + 共享后半段 ──

/** 组合形态：provision（源→构建→传输）→ activate（运行+暴露）→ captureArtifact（产物入库）；
 *  custom 形态（逻辑库）全程自控，不穿零点、无产物。 */
export async function executeForm(h: Harness, ctx: StageCtx, form: DeployForm): Promise<void> {
  if (form.run) return form.run(ctx, h);
  const provision = await form.provision!(ctx, h);
  await activate(h, ctx, provision);
  await captureArtifact(h, ctx, provision);
}

/** Run + Expose 共享段：preflight 对账 → up -d → 有域名则 edge 全量对账 → sha 回写 */
export async function activate(h: Harness, ctx: StageCtx, p: Provision): Promise<void> {
  const { target, log } = ctx;
  const serverId = await h.nodeServerId(target);
  await ctx.setStatus("deploying", p.sha ? { commitSha: p.sha } : {});
  // 对账用容器名：compose 项目名定死（远端 -p 一致），显式 container_name 优先
  if (p.containerNames.length > 0)
    await h.preflightCheck(target, serverId, p.containerNames, log);

  // 共享资源复用时只 up 业务服务子集（compose 仍会拉起 depends_on 依赖——复用场景的 compose 不应依赖被跳过的中间件）
  const upArg = p.upServices?.length ? ` ${p.upServices.join(" ")}` : "";
  if (upArg) await log(`只部署业务服务：${p.upServices!.join("、")}（中间件复用服务器共享资源）`);
  await log("远端 docker compose up -d …");
  // 注意：-f 一旦指定就只认列出的文件，base 必须一起带上（composeArgs 由 provision 拼好）
  const up = await h.sshExec(
    serverId,
    `cd "${p.remoteDir}" && docker compose${p.project ? ` -p ${p.project}` : ""}${p.composeArgs ? ` ${p.composeArgs}` : ""} up -d${upArg}`,
  );
  await log(up.stdout + up.stderr);
  if (up.code !== 0) throw new ServiceError(`远端 compose up 失败（exit ${up.code}）`);

  // 有域名绑定 → edge 全量对账（路由 + 证书状态回写）
  const domains = await h.edge.domainsOfTarget(target.id);
  if (domains.length > 0) {
    await log("同步 edge 路由与证书 …");
    await h.edge.syncServer(serverId, log);
  }

  if (p.sha) await h.repo.updateTarget(target.id, { lastKnownSha: p.sha, updateAvailable: false });
}

/**
 * 部署成功收尾：产物入库（compose/env/override 快照 enc1 加密 + 镜像打 run tag + run.artifactId 回写）。
 * 这是回滚的唯一原料；此处失败只记警告，绝不让成功的部署翻盘成失败。
 */
export async function captureArtifact(h: Harness, ctx: StageCtx, p: Provision): Promise<void> {
  const { target, run: dep, log } = ctx;
  try {
    const snapshotJson = encryptSecret(JSON.stringify(p.snapshot));
    // 逐服务打 tag：dockyard-<targetId>-<svc>:run-<runId>（不动用户 compose 的镜像名）
    let imageTags: Record<string, string> | undefined;
    if (p.services) {
      imageTags = {};
      const serverId = await h.nodeServerId(target);
      for (const [svc, def] of Object.entries(p.services)) {
        if (!def.image) continue;
        // upServices 子集外的服务本次没起来，跳过 pin（回滚时 pin 不存在的 tag 会让 up 拉取失败）
        if (p.upServices?.length && !p.upServices.includes(svc)) continue;
        const tag = `dockyard-${target.id}-${svc.toLowerCase()}:run-${dep.id}`;
        const r = await h.sshExec(serverId, `docker tag "${def.image}" "${tag}"`);
        if (r.code !== 0) {
          await log(`⚠️ 镜像快照 tag 失败（${svc}）：${r.stderr}`);
          continue;
        }
        imageTags[svc] = tag;
      }
      if (!Object.keys(imageTags).length) imageTags = undefined;
    }
    const artifact = await h.repo.createArtifact({
      targetId: target.id,
      runId: dep.id,
      project: p.project ?? null,
      imageTags,
      snapshotJson,
      sha: p.sha ?? null,
    });
    await h.repo.updateDeployment(dep.id, { artifactId: artifact.id });
    await log("📸 已记录部署产物（可回滚）");
  } catch (error) {
    await log(`⚠️ 产物记录失败（不影响部署结果）：${(error as Error).message}`);
  }
}

// ── 回滚 = 激活旧产物：快照文件写独立回滚目录（不污染在跑的 remoteDir，更不弄脏远端 git 检出目录），
//    有 imageTags 时生成 pin 覆盖文件锁死旧镜像，up 时 -p 沿用当初项目名 ──
export async function activateArtifact(h: Harness, ctx: StageCtx, artifact: DeployArtifact): Promise<void> {
  const { target, log } = ctx;
  const snapshot = JSON.parse(decryptSecret(artifact.snapshotJson)) as {
    compose: string;
    override: string;
    env: string;
  };
  const serverId = await h.nodeServerId(target);
  const client = await h.serverService.ssh(serverId);
  const rollbackDir = await h.resolveRemoteDir(client, `~/dockyard/rollback/${target.id}`);
  await client.exec(`mkdir -p ${rollbackDir}`);
  const sftp = await openSftp(client);
  await sftp.write(`${rollbackDir}/docker-compose.yml`, snapshot.compose);
  if (snapshot.env) await sftp.write(`${rollbackDir}/.env`, snapshot.env);
  if (snapshot.override) await sftp.write(`${rollbackDir}/docker-compose.dockyard.yml`, snapshot.override);

  const files = ["-f docker-compose.yml"];
  if (snapshot.override) files.push("-f docker-compose.dockyard.yml");
  // 镜像 pin：up 用旧 tag，不触发 build / 拉新
  const pinned = Object.entries(artifact.imageTags ?? {}).filter(
    ([svc]) => !target.upServices?.length || target.upServices.includes(svc),
  );
  if (pinned.length) {
    const yaml = ["services:", ...pinned.map(([svc, img]) => `  ${svc}:\n    image: ${img}`), ""].join("\n");
    await sftp.write(`${rollbackDir}/docker-compose.rollback.yml`, yaml);
    files.push("-f docker-compose.rollback.yml");
  }
  await sftp.close();

  // env_file 占位（同两条部署路径：文件必须存在，值由 .env/override 注入）
  for (const p of envFilePaths(snapshot.compose)) {
    if (p.startsWith("..") || p.startsWith("/")) continue;
    await client.exec(
      `cd ${rollbackDir} && mkdir -p "$(dirname "${p}")" && [ -f "${p}" ] || printf '# dockyard 占位\\n' > "${p}"`,
    );
  }

  // -p 与当初一致才不会起第二套容器；容器名从远端 config 推导做对账
  const project = artifact.project ?? `dockyard-${target.id}`;
  const cfgOut = await h.sshExec(serverId, `cd ${rollbackDir} && docker compose ${files.join(" ")} config --format json`);
  if (cfgOut.code === 0) {
    const cfg = JSON.parse(cfgOut.stdout) as {
      services?: Record<string, { container_name?: string }>;
    };
    const names = Object.entries(cfg.services ?? {}).map(([svc, def]) => def.container_name ?? `${project}-${svc}-1`);
    if (names.length) await h.preflightCheck(target, serverId, names, log);
  }

  const upArg = target.upServices?.length ? ` ${target.upServices.join(" ")}` : "";
  await log(`回滚到产物 #${artifact.id}（${artifact.sha ?? "无 sha"}）…`);
  const up = await h.sshExec(
    serverId,
    `cd ${rollbackDir} && docker compose -p ${project} ${files.join(" ")} up -d${upArg}`,
  );
  await log(up.stdout + up.stderr);
  if (up.code !== 0) throw new ServiceError(`回滚 compose up 失败（exit ${up.code}）`);

  const domains = await h.edge.domainsOfTarget(target.id);
  if (domains.length) {
    await log("同步 edge 路由与证书 …");
    await h.edge.syncServer(serverId, log);
  }
  // sha 回退到旧值：徽章与"有更新"语义跟着回滚走
  if (artifact.sha) await h.repo.updateTarget(target.id, { lastKnownSha: artifact.sha });
}
