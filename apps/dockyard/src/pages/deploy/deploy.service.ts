import { ServiceError } from "@elysiax/core";
import { dirname, join, normalize } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { openSftp } from "@meitaim/ssh/sftp";
import type { AppPaths } from "../../shared/paths";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import { CANVAS_CHANNEL, events } from "./events";
import type { DeployTarget, Deployment, DepEdge, TargetService } from "./schema";
import type { Project, ProjectService } from "../projects/projects.socket";
import type { ResourceService, SharedEnv } from "../resources/resources.socket";
import type { ServerService } from "../servers/servers.socket";
import { parseOwnerRepo, type GithubService } from "../github/github.socket";
import type { CanvasService } from "../canvas/canvas.socket";
import { isLocalHost } from "../canvas/canvas.socket";
import type { DeployRepository } from "./deploy.repository";
import type { EdgeService } from "../edge/edge.socket";
import { envFilePaths, type DetectedService } from "./detect";
import {
  containerNameOf,
  dbCompose,
  generatePassword,
  instanceUrl,
  LOGICAL_DB_SUPPORT,
  logicalDbCommands,
  logicalDbUrl,
  suggestedEnvKey,
  type DbType,
} from "../resources/resources.socket";

type Log = (line: string) => Promise<void>;

/** 每个 target 保留的部署历史条数（超出由 pruneRuns 清理，chunks 级联删除） */
const RUNS_KEEP = 20;

/** 可引用的数据库连接（app 依赖选择器的一行） */
export interface DbRef {
  id: number;
  nodeId: number;
  name: string;
  dbType: DbType;
  logical: boolean;
  url: string;
  displayUrl: string; // 脱敏预览（密码段 •••），选择器里展示用
  envKey: string; // 建议注入的变量名（DATABASE_URL / REDIS_URL）
}

/** 流式执行本地命令，输出写入部署日志；env 用于注入 DOCKER_DEFAULT_PLATFORM 等覆盖 */
async function run(cmd: string[], cwd: string, log: Log, env?: Record<string, string>): Promise<void> {
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
function dockerArch(raw: string): string {
  const r = raw.trim().toLowerCase();
  if (r === "x86_64" || r === "amd64" || r === "x64") return "amd64";
  if (r === "aarch64" || r === "arm64") return "arm64";
  if (r.startsWith("armv7")) return "arm/v7";
  return r;
}

export class DeployService {
  /** 防同 target 重入 */
  private running = new Map<number, Promise<void>>();
  /** serverId → docker 架构名（remoteArch 缓存） */
  private readonly archCache = new Map<number, string>();

  constructor(
    private readonly repo: DeployRepository,
    private readonly serverService: ServerService,
    private readonly github: GithubService,
    private readonly canvas: CanvasService,
    private readonly paths: AppPaths,
    private readonly edge: EdgeService,
    private readonly project: ProjectService,
    private readonly resourceService: ResourceService,
  ) { }

  /** 项目导入来源：github = 远端拉代码+服务器构建；local = 本地构建+镜像推送。
   *  旧数据 sourceType 为 null，按 localPath/repoUrl 推断。
   *  世界地图：归属在 target.projectId 上；未关联时按 repoUrl 反查项目兜底。 */
  private async sourceOf(target: DeployTarget): Promise<{ type: "local" | "github"; project?: Project }> {
    const project = target.projectId
      ? await this.project.byId(target.projectId)
      : (await this.project.list()).find((p) => p.repoUrl && p.repoUrl === target.repoUrl);
    const type: "local" | "github" =
      project?.sourceType ?? (project?.localPath && !target.repoUrl ? "local" : "github");
    return { type, project };
  }

  targetsOfNode(nodeId: number) {
    return this.repo.targetsOfNode(nodeId);
  }

  targetById(id: number) {
    return this.repo.targetById(id);
  }

  latestDeployment(targetId: number) {
    return this.repo.latestDeployment(targetId);
  }

  /** 整段日志（分块拼接；兼容存量 logText 行） */
  logTextOf(runId: number) {
    return this.repo.logTextOf(runId);
  }

  /** 同卡片同类型名称唯一（db 层还有唯一索引兜底，这里给用户友好报错） */
  private async assertNameFree(nodeId: number, kind: "app" | "db", name: string) {
    const dup = (await this.repo.targetsOfNode(nodeId)).find(
      (t) => t.kind === kind && t.name === name,
    );
    if (dup) throw new ServiceError(`该服务器上已存在同名${kind === "db" ? "数据库" : "应用"}「${name}」`);
  }

  async createAppTarget(input: {
    nodeId: number; name: string; repoUrl?: string; branch: string;
    composePath: string; serviceName?: string; remoteDir: string;
    envText?: string; // 识别结果合并出的 .env（enc1: 加密落库）
    overrideCompose?: string | null; // 资源限制 override（compose -f 叠加）
    dependsOn?: number[]; // 依赖的 db target id（画布连线 + 连接串引用血缘）
    domains?: { hostname: string; serviceName?: string; targetPort: number }[];
    services?: DetectedService[]; // compose 服务清单（画布小卡片；剥离秘密值后明文落库）
    upServices?: string[]; // 实际 up 的服务子集（共享资源复用过滤中间件；undefined = 全量）
    projectId?: number; // 项目归属（缺省按 repoUrl 反查项目；都没有 → null 未关联）
  }) {
    if (input.repoUrl?.trim()) parseOwnerRepo(input.repoUrl); // 提前校验（本地导入可无仓库）
    await this.assertNameFree(input.nodeId, "app", input.name);
    const { envText, overrideCompose, domains, dependsOn, services, upServices, projectId, ...base } = input;
    // 世界地图：项目归属落在 target 上——显式传入优先，否则按仓库地址反查
    const project = projectId
      ? await this.project.byId(projectId)
      : (await this.project.list()).find((p) => p.repoUrl && p.repoUrl === input.repoUrl?.trim());
    const target = await this.repo.createTarget({
      kind: "app",
      ...base,
      projectId: project?.id ?? null,
      ...(dependsOn?.length ? { dependsOn } : {}),
      ...(upServices?.length ? { upServices } : {}),
      // 只存 name/port：env 是秘密（envJson/overrideCompose 加密通道），cpu/mem 已在 override
      ...(services ? { servicesJson: { services: services.map((s) => ({ name: s.name, port: s.port })) } } : {}),
    });
    // 逻辑库容器名定死（对账用）；app 的容器名由用户 compose 决定，config 时读
    if (envText?.trim() || overrideCompose)
      await this.repo.updateTarget(target.id, {
        ...(envText?.trim() ? { envJson: encryptSecret(envText) } : {}),
        // override 含服务级 environment（秘密值），enc1: 加密落库
        ...(overrideCompose ? { overrideCompose: encryptSecret(overrideCompose) } : {}),
      });
    // 域名归 edge 上下文（含抢占检查）；建行后再绑，失败则整单撤掉
    try {
      for (const d of domains ?? [])
        await this.edge.addDomain(target.id, d);
    } catch (e) {
      await this.repo.removeTarget(target.id);
      throw e;
    }
    return (await this.repo.targetById(target.id))!;
  }

  /**
   * app 的 compose 服务清单（画布小卡片 + 容器标签对账）：
   * 优先读 servicesJson 列；为 null（存量 target）则从本地仓库缓存跑 compose config 惰性补全并写回。
   * 一切失败都静默降级为空——画布轮询路径不能因为补全挂掉。
   */
  async servicesOfTarget(target: DeployTarget): Promise<{ project: string | null; services: TargetService[] }> {
    if (target.kind !== "app") return { project: null, services: [] };
    const fallbackProject = `dockyard-${target.id}`; // 与 deployApp 的 cfg.name ?? dockyard-<id> 同源
    if (target.servicesJson)
      return { project: target.servicesJson.project ?? fallbackProject, services: target.servicesJson.services };
    try {
      // 本地导入直接读项目目录；GitHub 导入读本地克隆缓存（远端构建后缓存可能不存在 → 静默降级）
      const { type, project } = await this.sourceOf(target);
      const repoDir =
        type === "local" && project?.localPath
          ? join(project.localPath, project.rootDir ?? "")
          : join(this.paths.reposDir, `target-${target.id}`);
      if (!existsSync(repoDir)) return { project: null, services: [] };
      const composePath = target.composePath ?? "docker-compose.yml";
      // env_file 多为 gitignore 的本地秘密（仓库缓存里没有）→ 写占位，否则 compose config 直接报错（同 deployApp 远端做法）
      const composeText = await Bun.file(join(repoDir, composePath)).text();
      for (const p of envFilePaths(composeText)) {
        // 相对 compose 文件所在目录解析；${VAR:-default} 取默认值（与 compose 行为一致）
        const resolved = p.replace(/\$\{[^}:]+:-([^}]*)\}/g, "$1");
        const abs = join(repoDir, dirname(composePath), resolved);
        if (!existsSync(abs)) {
          await mkdir(dirname(abs), { recursive: true });
          await Bun.write(abs, "# dockyard 占位：真实环境变量在 docker-compose.dockyard.yml 的 environment 里\n");
        }
      }
      const proc = Bun.spawn(
        ["docker", "compose", "-f", composePath, "config", "--format", "json"],
        { cwd: repoDir, stdout: "pipe", stderr: "ignore" },
      );
      const cfg = JSON.parse(await new Response(proc.stdout).text()) as {
        name?: string;
        services?: Record<string, { image?: string; ports?: { published?: string | number }[] }>;
      };
      if ((await proc.exited) !== 0) return { project: null, services: [] };
      const services = Object.entries(cfg.services ?? {}).map(([name, def]): TargetService => {
        const published = def.ports?.[0]?.published;
        const port = published === undefined ? undefined : Number(published);
        return { name, image: def.image, port: Number.isFinite(port) ? port : undefined };
      });
      const doc = { ...(cfg.name ? { project: cfg.name } : {}), services };
      await this.repo.updateTarget(target.id, { servicesJson: doc }).catch(() => {});
      return { project: cfg.name ?? fallbackProject, services };
    } catch {
      return { project: null, services: [] };
    }
  }

  /** 域名变更后的 edge 全量对账（增删域名、手动「重新同步」按钮共用） */
  async syncEdge(targetId: number, log: Log = async () => {}) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError("部署目标不存在");
    await this.edge.syncServer(await this.nodeServerId(target), log);
  }

  // ── 依赖与连接串引用 ──

  /** 项目空间内可引用的数据库连接（app 向导/变量抽屉的选择器数据）。
   *  世界地图：节点不再携带项目——取卡上已有 target 的项目归属；全新服务器卡无归属时返回空 */
  async dbRefsOfNode(nodeId: number): Promise<DbRef[]> {
    const projectId = (await this.repo.targetsOfNode(nodeId)).find((t) => t.projectId)?.projectId;
    if (!projectId) return [];
    const dbs = await this.repo.dbTargetsOfProject(projectId);
    const refs: DbRef[] = [];
    for (const db of dbs) {
      if (!db.dbType || !db.envJson) continue;
      let url: string | null = null;
      try {
        const parsed = JSON.parse(decryptSecret(db.envJson)) as Record<string, unknown>;
        if (db.instanceOf) {
          url = typeof parsed.url === "string" ? parsed.url : null; // 逻辑库：凭据创建时生成
        } else {
          const server = await this.serverService.byId(await this.nodeServerId(db));
          url = instanceUrl(db.dbType as DbType, server?.host ?? "", String(parsed.env ?? ""));
        }
      } catch { /* 跳过坏记录 */ }
      if (!url) continue;
      refs.push({
        id: db.id, nodeId: db.nodeId, name: db.name,
        dbType: db.dbType as DbType, logical: Boolean(db.instanceOf),
        url,
        displayUrl: url.replace(/(\/\/[^:/@]+:)[^@]+(@)/, "$1•••$2"),
        envKey: suggestedEnvKey(db.dbType as DbType),
      });
    }
    return refs;
  }

  /** 目标所在服务器的共享变量（Env Tab 下拉引用；url 已解密，仅本机控制面） */
  async sharedEnvOfTarget(targetId: number): Promise<SharedEnv[]> {
    const target = await this.repo.targetById(targetId);
    if (!target) return [];
    return this.resourceService.sharedEnvOf(await this.nodeServerId(target));
  }

  /** Source Tab：更新来源配置（仓库/分支/compose 路径/远端目录） */
  async updateSource(
    targetId: number,
    patch: { repoUrl?: string; branch?: string; composePath?: string; remoteDir?: string },
  ) {
    const target = await this.repo.targetById(targetId);
    if (!target || target.kind !== "app") throw new ServiceError("部署目标不存在");
    if (patch.repoUrl?.trim()) parseOwnerRepo(patch.repoUrl);
    await this.repo.updateTarget(targetId, {
      ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl.trim() || null } : {}),
      ...(patch.branch?.trim() ? { branch: patch.branch.trim() } : {}),
      ...(patch.composePath?.trim() ? { composePath: patch.composePath.trim() } : {}),
      ...(patch.remoteDir?.trim() ? { remoteDir: patch.remoteDir.trim() } : {}),
    });
  }

  /** app 的 .env 明文（变量抽屉回显；enc1: 解密，仅本机控制面） */
  envTextOf(target: DeployTarget): string {
    if (!target.envJson) return "";
    try {
      return decryptSecret(target.envJson);
    } catch {
      return "";
    }
  }

  /** 逻辑库连接串（画布复制按钮；本地控制面，落库已 enc1: 加密）。非逻辑库 → undefined */
  logicalUrlOf(target: DeployTarget): string | undefined {
    if (target.kind !== "db" || !target.instanceOf || !target.envJson) return undefined;
    try {
      return (JSON.parse(decryptSecret(target.envJson)) as { url?: string }).url;
    } catch {
      return undefined;
    }
  }

  /** 变量抽屉保存：.env（enc1: 加密）+ 依赖血缘（画布连线） */
  async updateAppEnv(targetId: number, envText: string, dependsOn: number[]) {
    const target = await this.repo.targetById(targetId);
    if (!target || target.kind !== "app") throw new ServiceError("部署目标不存在");
    await this.repo.updateTarget(targetId, {
      envJson: envText.trim() ? encryptSecret(envText) : null,
      dependsOn: dependsOn.length ? dependsOn : null,
    });
  }

  /** 画布拖线建/删依赖：整组覆盖服务级边；dependsOn 是派生血缘（变量抽屉选择器用），双写保持一致 */
  async setDependsOn(targetId: number, edges: DepEdge[]) {
    const target = await this.repo.targetById(targetId);
    if (!target || target.kind !== "app") throw new ServiceError("部署目标不存在");
    const dependsOn = [...new Set(edges.map((e) => e.db))];
    await this.repo.updateTarget(targetId, {
      depEdges: edges.length ? edges : null,
      dependsOn: dependsOn.length ? dependsOn : null,
    });
  }

  /** app 的服务级依赖边（depEdges 为空的存量数据从 dependsOn 惰性派生，service=null 表示整体依赖） */
  edgesOfTarget(target: DeployTarget): DepEdge[] {
    if (target.depEdges) return target.depEdges;
    return (target.dependsOn ?? []).map((db) => ({ service: null, db }));
  }

  /** 画布布局持久化：app/db 卡位置 + 服务卡位置（serviceLayout 全量覆盖，岛端合并后传） */
  async setLayout(targetId: number, patch: { x?: number; y?: number; w?: number; h?: number; groupId?: number | null; serviceLayout?: Record<string, { x: number; y: number }> }) {
    await this.repo.updateTarget(targetId, patch);
  }

  /** 删除分组：组内目标回落到服务器卡 */
  async clearGroup(groupId: number) {
    await this.repo.clearGroup(groupId);
  }

  // ── 部署历史（服务抽屉 Deployments Tab）──

  deploymentsOfTarget(targetId: number) {
    return this.repo.deploymentsOfTarget(targetId);
  }

  deploymentById(id: number) {
    return this.repo.deploymentById(id);
  }

  /** override compose 整列覆盖（runtime 原子的资源限制/服务变量保存用；enc1: 加密在调用方） */
  async updateOverrideCompose(targetId: number, overrideCompose: string | null) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError("部署目标不存在");
    await this.repo.updateTarget(targetId, { overrideCompose });
  }

  /** 部署策略三态：manual 不轮询 / notify 只亮徽章 / auto 检出更新即部署（轮询器读此列） */
  async setDeployPolicy(targetId: number, deployPolicy: DeployTarget["deployPolicy"]) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError("部署目标不存在");
    await this.repo.updateTarget(targetId, { deployPolicy });
  }

  /** 该节点上可托管逻辑库的实例（kind=db、同类型、非逻辑库） */
  async instancesOfNode(nodeId: number, dbType: DbType): Promise<DeployTarget[]> {
    return (await this.repo.targetsOfNode(nodeId)).filter(
      (t) => t.kind === "db" && !t.instanceOf && t.dbType === dbType,
    );
  }

  /** 数据库目标（实例）：模板 compose + 凭据在创建时生成一次，enc1: 加密存 envJson。
   *  容器名/所有权标签依赖 target id，先建行再回填。 */
  async createDbTarget(input: { nodeId: number; name: string; dbType: DbType; remoteDir: string; projectId?: number }) {
    await this.assertNameFree(input.nodeId, "db", input.name);
    if (!input.remoteDir.trim()) throw new ServiceError("新建实例需要填写远端目录");
    const target = await this.repo.createTarget({ kind: "db", ...input });
    const rendered = dbCompose(input.dbType, input.name, {
      targetId: target.id,
      // compose 项目名：有归属按项目，未关联兜底 target id（保持全局唯一）
      project: `project-${input.projectId ?? target.id}`,
    });
    const containerName = containerNameOf(target.id, input.name);
    await this.repo.updateTarget(target.id, {
      envJson: encryptSecret(JSON.stringify(rendered)),
      containerName,
    });
    return (await this.repo.targetById(target.id))!;
  }

  /** 逻辑库目标：不起容器，凭据创建时生成，部署 = 在宿主实例里 CREATE DATABASE */
  async createLogicalDbTarget(input: { nodeId: number; name: string; instanceId: number }) {
    const instance = await this.repo.targetById(input.instanceId);
    if (!instance || instance.kind !== "db" || instance.instanceOf)
      throw new ServiceError("宿主实例不存在");
    if (!LOGICAL_DB_SUPPORT[instance.dbType as DbType])
      throw new ServiceError(`${instance.dbType} 不支持逻辑库`);
    await this.assertNameFree(input.nodeId, "db", input.name);
    const serverId = await this.nodeServerId(instance);
    const server = await this.serverService.byId(serverId);
    const password = generatePassword();
    const url = logicalDbUrl(instance.dbType as DbType, server!.host, input.name, password);
    return this.repo.createTarget({
      kind: "db",
      nodeId: input.nodeId,
      name: input.name,
      dbType: instance.dbType,
      instanceOf: instance.id,
      projectId: instance.projectId, // 逻辑库跟随宿主实例的项目归属
      envJson: encryptSecret(JSON.stringify({ url, password })),
    });
  }

  /** 删除：实例旗下有逻辑库时阻止；逻辑库只删记录（不 DROP DATABASE） */
  async removeTarget(id: number) {
    const target = await this.repo.targetById(id);
    if (!target) return;
    if (target.kind === "db" && !target.instanceOf) {
      const children = await this.repo.childrenOf(id);
      if (children.length > 0)
        throw new ServiceError(
          `实例下还有逻辑库：${children.map((c) => c.name).join("、")}，请先删除它们`,
        );
    }
    return this.repo.removeTarget(id);
  }

  isRunning(targetId: number) {
    return this.running.has(targetId);
  }

  /** 触发部署（幂等防重入；调用方通常不 await）。trigger 标记来源（ui/auto），进 run 血缘 */
  deploy(targetId: number, opts?: { trigger?: Deployment["trigger"] }): Promise<void> {
    const hit = this.running.get(targetId);
    if (hit) return hit;
    const task = this.pipeline(targetId, opts?.trigger ?? "ui")
      .catch(() => { })
      .finally(() => this.running.delete(targetId));
    this.running.set(targetId, task);
    return task;
  }

  private async pipeline(targetId: number, trigger: Deployment["trigger"]) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError(`部署目标不存在: ${targetId}`);
    // 画布 SSE 全局频道：状态迁移实时推给订阅画布的浏览器（structure 不变，不走 refresh）
    const ch = CANVAS_CHANNEL;
    const dep = await this.repo.createDeployment(targetId, { trigger });
    const log = this.makeLog(dep.id, targetId);
    const setStatus = async (status: Deployment["status"], patch: Partial<Deployment> = {}) => {
      await this.repo.updateDeployment(dep.id, { status, ...patch });
      events.publish(ch, { type: "status", targetId, status });
    };

    events.publish(ch, { type: "running", targetId, running: true });
    events.publish(ch, { type: "status", targetId, status: "queued" });
    try {
      if (target.kind === "app") await this.deployApp(target, log, setStatus, dep.id);
      else if (target.instanceOf) await this.deployLogicalDb(target, log);
      else await this.deployDb(target, log, dep.id);
      await setStatus("success", { finishedAt: new Date() });
      await log("✅ 部署完成");
      await this.repo.pruneRuns(targetId, RUNS_KEEP);
    } catch (error) {
      await log(`❌ ${(error as Error).message}`);
      await setStatus("failed", { finishedAt: new Date() });
    } finally {
      await log.flush(); // 终态前推空缓冲，抽屉侧才能即时收尾
      events.publish(ch, { type: "running", targetId, running: false });
    }
  }

  /**
   * 部署日志 writer：chunk 落库 + SSE 增量推送。
   * 落库逐行（appendLogChunk 单行 insert 足够快）；SSE 必须合并——
   * execLongRemote 一个 256KB 轮询窗口可能含上千行，逐行 publish 会打爆频道。
   * 窗口规则：满 50 行立即 flush，否则 100ms 后 flush；终态由 pipeline 强制 flush。
   */
  private makeLog(runId: number, targetId: number): Log & { flush(): Promise<void> } {
    let buf: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!buf.length) return;
      const lines = buf;
      buf = [];
      events.publish(CANVAS_CHANNEL, { type: "log", targetId, runId, lines });
    };
    const log: Log = async (line) => {
      if (!line.trim()) return;
      await this.repo.appendLogChunk(runId, line);
      buf.push(line);
      if (buf.length >= 50) await flush();
      else timer ??= setTimeout(() => void flush(), 100);
    };
    return Object.assign(log, { flush });
  }

  /** SFTP 不做 shell 展开，`~` 是字面路径（No such file）——先解析成绝对路径 */
  private async resolveRemoteDir(
    client: { exec(cmd: string): Promise<{ stdout: string }> },
    dir: string,
  ): Promise<string> {
    if (!dir.startsWith("~")) return dir;
    const { stdout } = await client.exec('printf %s "$HOME"');
    return `${stdout.trim()}${dir.slice(1)}`;
  }

  // ── 部署前对账：远端同名容器归属校验，绝不动别人的容器 ──
  private async preflightCheck(
    target: DeployTarget,
    serverId: number,
    containerNames: string[],
    log: Log,
  ) {
    const remote = await this.serverService.docker(serverId);
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
  }

  // ── 逻辑库：不起容器，在宿主实例里 CREATE DATABASE + 专属账号 ──
  private async deployLogicalDb(target: DeployTarget, log: Log) {
    const instance = await this.repo.targetById(target.instanceOf!);
    if (!instance?.containerName) throw new ServiceError("宿主实例不存在或缺少容器名");
    const serverId = await this.nodeServerId(instance);
    const remote = await this.serverService.docker(serverId);

    const containers = await remote.listContainers({ all: true });
    const hit = containers.find((c) => c.Names.includes(`/${instance.containerName}`));
    if (!hit) throw new ServiceError(`宿主实例容器 ${instance.containerName} 不存在，请先部署实例「${instance.name}」`);
    if (
      hit.Labels?.["dockyard.managed"] !== "true" ||
      hit.Labels?.["dockyard.target-id"] !== String(instance.id)
    )
      throw new ServiceError(`宿主实例容器 ${instance.containerName} 标签校验失败（非本工具创建），已阻止`);
    if (hit.State !== "running") throw new ServiceError(`宿主实例「${instance.name}」未运行（${hit.State}）`);

    const creds = JSON.parse(decryptSecret(target.envJson!)) as { url: string; password: string };
    const cmds = logicalDbCommands(instance.dbType as DbType, target.name, creds.password);
    const container = remote.getContainer(hit.Id);
    const execIn = async (cmd: string[]): Promise<{ code: number; output: string }> => {
      // 不开 Tty：psql 检测到 TTY 会起 pager（less）把 exec 挂死。
      // hijack + demuxStream 拆多路复用的 stdout/stderr。
      const ex = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
      const stream = await ex.start({ hijack: true, stdin: false });
      let out = "";
      let err = "";
      const collect = (sink: (s: string) => void) =>
        new Writable({
          write(chunk: Buffer, _enc, cb) {
            sink(chunk.toString("utf8"));
            cb();
          },
        });
      remote.modem.demuxStream(stream, collect((s) => (out += s)), collect((s) => (err += s)));
      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      const { ExitCode } = await ex.inspect();
      return { code: ExitCode ?? -1, output: `${out}\n${err}`.trim() };
    };

    // 幂等：已存在时，只有"上次我们部署成功过"才跳过，否则视为别人的库，阻止
    const exists = await execIn(cmds.exists);
    // pg/mysql 查到返回 1；mongosh 打印 true/false——统一按词匹配，"false" 不误判
    if (exists.code === 0 && /\b(1|true)\b/.test(exists.output)) {
      const prev = await this.repo.lastSuccessfulDeployment(target.id);
      if (prev?.status === "success") {
        await log(`逻辑库 ${target.name} 已存在（上次部署创建），跳过`);
        return;
      }
      throw new ServiceError(`实例「${instance.name}」中已存在名为 ${target.name} 的库且非本工具创建，已阻止`);
    }

    await log(`在实例「${instance.name}」中创建逻辑库 ${target.name} …`);
    for (const cmd of cmds.create) {
      const created = await execIn(cmd);
      if (created.code !== 0) throw new ServiceError(`创建逻辑库失败：${created.output}`);
    }
    // 日志里不出现明文密码
    await log(`连接串：${creds.url.replace(creds.password, "****")}`);
  }

  // ── app：按项目来源分派（统一引擎，仅「代码获取 + 镜像构建」分支）──
  // github = 远端服务器拉代码、服务器上构建镜像；local = 本地客户端构建、推送镜像到服务器
  private async deployApp(
    target: DeployTarget,
    log: Log,
    setStatus: (s: Deployment["status"], p?: Partial<Deployment>) => Promise<unknown>,
    runId: number,
  ) {
    const { type, project } = await this.sourceOf(target);
    if (type === "local") {
      if (!project?.localPath) throw new ServiceError("本地导入的项目缺少 localPath");
      return this.deployAppLocalBuild(target, project, log, setStatus, runId);
    }
    return this.deployAppRemoteBuild(target, log, setStatus, runId);
  }

  /**
   * 远端服务器架构（uname -m 映射 docker 名，内存缓存——硬件不会中途变）。
   * 本地构建跨架构时用它决定 DOCKER_DEFAULT_PLATFORM。
   */
  private async remoteArch(serverId: number): Promise<string> {
    const hit = this.archCache.get(serverId);
    if (hit) return hit;
    const r = await this.sshExec(serverId, "uname -m");
    const arch = dockerArch(r.stdout);
    this.archCache.set(serverId, arch);
    return arch;
  }

  /** 本地构建的目标平台：target.buildPlatform 显式指定优先，否则远端架构与本机不同才跨架构构建 */
  private async localBuildPlatform(target: DeployTarget, serverId: number): Promise<string | undefined> {
    if (target.buildPlatform) return target.buildPlatform;
    const remote = await this.remoteArch(serverId);
    return remote === dockerArch(process.arch) ? undefined : `linux/${remote}`;
  }

  /**
   * 本地构建 + 产物传输（deployAppLocalBuild 前半段，也是「传输产物」动作的本体）：
   * 本地 build → docker save → dockerode 经 SSH relay load 到远端。
   * 成功即置 artifactShipped——这是本地卡跨区移动的唯一门票（区域硬隔离的显式通道）。
   */
  private async shipLocalArtifact(
    target: DeployTarget,
    proj: Project,
    serverId: number,
    log: Log,
    setStatus?: (s: Deployment["status"], p?: Partial<Deployment>) => Promise<unknown>,
  ): Promise<{ repoDir: string; sha: string }> {
    const repoDir = join(proj.localPath!, proj.rootDir ?? "");
    await setStatus?.("building");
    const shaProc = Bun.spawn(["git", "rev-parse", "--short=8", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "ignore" });
    const sha = ((await new Response(shaProc.stdout).text()).trim()) || `local-${Date.now()}`;

    const composePath = target.composePath ?? "docker-compose.yml";
    const composeBase = ["docker", "compose", "-f", composePath];

    // 跨架构：远端是 arm64 而本机 amd64 时，必须经 buildx 出对应平台镜像——
    // 经典 builder 会静默忽略 DOCKER_DEFAULT_PLATFORM，产出本机架构镜像，远端起不来还难查
    const platform = await this.localBuildPlatform(target, serverId);
    let env: Record<string, string> | undefined;
    if (platform) {
      const buildx = Bun.spawn(["docker", "buildx", "version"], { stdout: "ignore", stderr: "ignore" });
      if ((await buildx.exited) !== 0)
        throw new ServiceError(`远端架构需要 ${platform} 镜像，但本机没有 docker buildx——请安装 Docker Buildx 插件`);
      await log(`跨架构构建 ${platform}（本机 ${process.arch} → 远端）…`);
      env = { DOCKER_DEFAULT_PLATFORM: platform };
    }
    await log(`本地构建 ${repoDir} @${sha} …`);
    await run(
      [...composeBase, "build", ...(target.serviceName ? [target.serviceName] : [])],
      repoDir, log, env,
    );

    // 用户决定怎么打包：镜像名从 compose 配置里读
    const imgProc = Bun.spawn(
      [...composeBase, "config", "--images", ...(target.serviceName ? [target.serviceName] : [])],
      { cwd: repoDir, stdout: "pipe" },
    );
    const images = (await new Response(imgProc.stdout).text()).trim().split("\n").filter(Boolean);
    if (images.length === 0) throw new ServiceError("compose 没有产生任何镜像");

    await setStatus?.("transferring", { commitSha: sha });
    const remote = await this.serverService.docker(serverId);
    for (const image of images) {
      await log(`传输镜像 ${image} …`);
      const save = Bun.spawn(["docker", "save", image], { stdout: "pipe" });
      // dockerode 要 Node stream；Bun.stdout 是 Bun 扩展的 Web stream（类型不完全重合）
      await remote.loadImage(
        Readable.fromWeb(save.stdout as unknown as import("stream/web").ReadableStream),
      );
      if ((await save.exited) !== 0) throw new ServiceError(`docker save 失败: ${image}`);
      await log(`已传输 ${image}`);
    }
    await this.repo.updateTarget(target.id, { artifactShipped: true });
    return { repoDir, sha };
  }

  // ── app · 本地文件夹导入：本地构建 → docker save → 远端 load → compose up ──
  private async deployAppLocalBuild(
    target: DeployTarget,
    proj: Project,
    log: Log,
    setStatus: (s: Deployment["status"], p?: Partial<Deployment>) => Promise<unknown>,
    runId: number,
  ) {
    const serverId = await this.nodeServerId(target);
    const { repoDir, sha } = await this.shipLocalArtifact(target, proj, serverId, log, setStatus);
    const composePath = target.composePath ?? "docker-compose.yml";
    const composeBase = ["docker", "compose", "-f", composePath];

    await setStatus("deploying");

    // 对账用容器名：compose 项目名定死（远端 -p 一致），显式 container_name 优先
    const cfgProc = Bun.spawn([...composeBase, "config", "--format", "json"], {
      cwd: repoDir,
      stdout: "pipe",
    });
    const cfg = JSON.parse(await new Response(cfgProc.stdout).text()) as {
      name?: string;
      services?: Record<string, { container_name?: string; image?: string }>;
    };
    const project = cfg.name ?? `dockyard-${target.id}`;
    const containerNames = Object.entries(cfg.services ?? {}).map(
      ([svc, def]) => def.container_name ?? `${project}-${svc}-1`,
    );
    if (containerNames.length > 0)
      await this.preflightCheck(target, serverId, containerNames, log);

    const client = await this.serverService.ssh(serverId);
    const remoteDir = await this.resolveRemoteDir(client, target.remoteDir ?? `~/dockyard/${target.name}`);
    await client.exec(`mkdir -p ${remoteDir}`);
    const sftp = await openSftp(client);
    const composeText = await Bun.file(join(repoDir, composePath)).text();
    await sftp.write(`${remoteDir}/docker-compose.yml`, composeText);
    // 用户 compose 的 env_file 是相对仓库的路径（远端没有目录树）——放空占位，
    // 否则 compose up 直接报 "env file not found"；真实值由 override 的 environment 注入
    for (const p of envFilePaths(composeText)) {
      await client.exec(
        `cd ${remoteDir} && mkdir -p "${join(".", p, "..")}" && [ -f "${p}" ] || printf '# dockyard 占位：真实环境变量在 docker-compose.dockyard.yml 的 environment 里\\n' > "${p}"`,
      );
    }
    if (target.envJson) await sftp.write(`${remoteDir}/.env`, decryptSecret(target.envJson));
    // 识别出的资源限制/服务级 environment 以 override compose 叠加（不改用户原 compose）
    if (target.overrideCompose)
      await sftp.write(`${remoteDir}/docker-compose.dockyard.yml`, decryptSecret(target.overrideCompose));
    await sftp.close();
    await log("远端 docker compose up -d …");
    // 注意：-f 一旦指定就只认列出的文件，base 必须一起带上
    const overrideArg = target.overrideCompose ? " -f docker-compose.yml -f docker-compose.dockyard.yml" : "";
    // 共享资源复用时只 up 业务服务子集（compose 仍会拉起 depends_on 依赖——复用场景的 compose 不应依赖被跳过的中间件）
    const upArg = target.upServices?.length ? ` ${target.upServices.join(" ")}` : "";
    if (upArg) await log(`只部署业务服务：${target.upServices!.join("、")}（中间件复用服务器共享资源）`);
    const up = await client.exec(`cd ${remoteDir} && docker compose -p ${project}${overrideArg} up -d${upArg}`);
    await log(up.stdout + up.stderr);
    if (up.code !== 0) throw new ServiceError(`远端 compose up 失败（exit ${up.code}）`);

    // 有域名绑定 → edge 全量对账（路由 + 证书状态回写）
    const domains = await this.edge.domainsOfTarget(target.id);
    if (domains.length > 0) {
      await log("同步 edge 路由与证书 …");
      await this.edge.syncServer(serverId, log);
    }

    await this.repo.updateTarget(target.id, { lastKnownSha: sha, updateAvailable: false });

    // 回滚原料：compose/env 快照 + 镜像打 run tag（up 已成功，此处失败只警告不翻盘）
    await this.snapshotRun({
      target, runId, serverId, project, log,
      compose: composeText,
      override: target.overrideCompose ? decryptSecret(target.overrideCompose) : "",
      env: target.envJson ? decryptSecret(target.envJson) : "",
      services: cfg.services,
    });
  }

  /** 带断线重连的短命令：连接失效则丢弃缓存重建后重试 */
  private async sshExec(serverId: number, cmd: string, retries = 2) {
    for (;;) {
      try {
        return await (await this.serverService.ssh(serverId)).exec(cmd);
      } catch (error) {
        if (retries-- <= 0) throw error;
        await this.serverService.dropSsh(serverId);
      }
    }
  }

  /**
   * 长跑命令（镜像构建）放远端后台执行 + 轮询日志文件：
   * 单条 exec 挂几十分钟会被中间网络/sshd 断开，通道一关命令就被 SIGHUP 杀掉；
   * nohup 后台 + 短轮询则断线只废掉一次轮询，重连后续跑，构建本体不受影响。
   */
  private async execLongRemote(
    serverId: number,
    cmd: string,
    tag: string,
    log: Log,
  ): Promise<{ code: number }> {
    const logFile = `/tmp/dockyard-long-${tag}.log`;
    const codeFile = `${logFile}.code`;
    const partFile = `${logFile}.part`;
    const quoted = cmd.replace(/'/g, `'\\''`);
    const start = await this.sshExec(
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
      let res: { stdout: string; stderr: string; code: number | null };
      try {
        res = await this.sshExec(
          serverId,
          // 窗口读取：每轮最多 256KB——构建日志可达数 MB，弱网下全量重传必然反复失败（偏移不涨、越传越大）
          // 服务端报告本次实际输出字节数，避免客户端按解码后字符串估算偏移踩 UTF-8 边界
          `tail -c +${offset + 1} ${logFile} 2>/dev/null | head -c 262144 > ${partFile}; cat ${partFile};` +
            `printf '\\n__DC_SIZE__\\n'; wc -c < ${partFile}; printf '__DC_CODE__\\n'; cat ${codeFile} 2>/dev/null || true`,
          0,
        );
      } catch {
        await this.serverService.dropSsh(serverId); // 本轮轮询撞上断线：重建连接下轮续跑
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
  }

  // ── app · GitHub 导入：远端服务器拉代码 → 服务器上构建镜像 → compose up（免镜像传输）──
  private async deployAppRemoteBuild(
    target: DeployTarget,
    log: Log,
    setStatus: (s: Deployment["status"], p?: Partial<Deployment>) => Promise<unknown>,
    runId: number,
  ) {
    if (!target.repoUrl) throw new ServiceError("GitHub 导入的部署目标缺少 repoUrl");
    const ownerRepo = parseOwnerRepo(target.repoUrl);
    const branch = target.branch ?? "main";
    const serverId = await this.nodeServerId(target);
    const client = await this.serverService.ssh(serverId);
    const authedUrl = await this.github.authedRepoUrl(ownerRepo);
    // git 报错会把整条带 token 的 URL 打进 stderr——所有日志/异常先脱敏
    const cred = authedUrl.match(/^https:\/\/([^@]+)@/)?.[1];
    const redact = (s: string) => (cred ? s.split(cred).join("***") : s);
    const rlog: Log = async (s) => log(redact(s));
    const srcDir = await this.resolveRemoteDir(client, `~/dockyard/src/${target.id}-${target.name}`);
    const composePath = target.composePath ?? "docker-compose.yml";

    // 1. 代码获取：远端 clone / fetch（token 不落盘——clone 后立即重写 remote）
    await setStatus("building");
    const probe = await client.exec(`[ -d "${srcDir}/.git" ] && echo yes || echo no`);
    if (probe.stdout.trim() !== "yes") {
      await rlog(`远端克隆 ${ownerRepo} …`);
      await client.exec(`mkdir -p "$(dirname "${srcDir}")"`);
      const clone = await client.exec(`git clone "${authedUrl}" "${srcDir}"`);
      if (clone.code !== 0) throw new ServiceError(redact(`远端克隆失败（exit ${clone.code}）\n${clone.stderr}`));
      await client.exec(`git -C "${srcDir}" remote set-url origin "https://github.com/${ownerRepo}.git"`);
    }
    const fetch = await client.exec(`git -C "${srcDir}" fetch "${authedUrl}" "${branch}" && git -C "${srcDir}" checkout FETCH_HEAD`);
    if (fetch.code !== 0) throw new ServiceError(redact(`远端拉取失败（exit ${fetch.code}）\n${fetch.stderr}`));
    const sha = (await client.exec(`git -C "${srcDir}" rev-parse --short=8 HEAD`)).stdout.trim();
    await rlog(`远端构建 ${ownerRepo}@${sha} …`);

    // 2. env_file 占位（compose config/build 要求文件存在；真实值由 override/.env 注入）。
    // compose 把 env_file 解析为「相对 compose 文件所在目录」，子目录 compose（deploy/x.yml 写 ../apps/.env）必须同样解析
    const composeText = (await client.exec(`cat "${srcDir}/${composePath}"`)).stdout;
    for (const p of envFilePaths(composeText)) {
      const rel = normalize(join(dirname(composePath), p));
      if (rel.startsWith("..") || rel.startsWith("/")) continue; // 逃出仓库的路径不创建
      await client.exec(
        `cd "${srcDir}" && mkdir -p "$(dirname "${rel}")" && [ -f "${rel}" ] || printf '# dockyard 占位\\n' > "${rel}"`,
      );
    }

    // 3. 服务器上构建镜像：后台跑 + 轮询（断线重连不杀构建，全量输出进部署日志）。
    // 逐服务串行构建——小内存 VPS 并行构建多个镜像会 OOM 到 sshd 都无响应
    const buildCmd = target.serviceName
      ? `docker compose -f "${composePath}" build ${target.serviceName}`
      : `for s in $(docker compose -f "${composePath}" config --services); do docker compose -f "${composePath}" build "$s" || exit 1; done`;
    const build = await this.execLongRemote(
      serverId,
      `cd "${srcDir}" && ${buildCmd}`,
      `build-${target.id}`,
      rlog,
    );
    if (build.code !== 0) throw new ServiceError(`远端构建失败（exit ${build.code}）`);

    // 4. 对账 + 环境变量/override 注入 + up
    await setStatus("deploying", { commitSha: sha });
    const cfgOut = await this.sshExec(serverId, `cd "${srcDir}" && docker compose -f "${composePath}" config --format json`);
    if (cfgOut.code !== 0) throw new ServiceError(redact(`远端 compose config 失败：${cfgOut.stderr}`));
    const cfg = JSON.parse(cfgOut.stdout) as {
      name?: string;
      services?: Record<string, { container_name?: string; image?: string }>;
    };
    const projectName = cfg.name ?? `dockyard-${target.id}`;
    const containerNames = Object.entries(cfg.services ?? {}).map(
      ([svc, def]) => def.container_name ?? `${projectName}-${svc}-1`,
    );
    if (containerNames.length > 0)
      await this.preflightCheck(target, serverId, containerNames, log);

    // 构建期间缓存连接可能已被丢弃重建——拿当前可用连接
    const fresh = await this.serverService.ssh(serverId);
    const sftp = await openSftp(fresh);
    if (target.envJson) await sftp.write(`${srcDir}/.env`, decryptSecret(target.envJson));
    if (target.overrideCompose)
      await sftp.write(`${srcDir}/docker-compose.dockyard.yml`, decryptSecret(target.overrideCompose));
    await sftp.close();
    await rlog("远端 docker compose up -d …");
    const overrideArg = target.overrideCompose ? ` -f "${composePath}" -f docker-compose.dockyard.yml` : ` -f "${composePath}"`;
    // 共享资源复用时只 up 业务服务子集（同本地构建路径的语义）
    const upArg = target.upServices?.length ? ` ${target.upServices.join(" ")}` : "";
    if (upArg) await rlog(`只部署业务服务：${target.upServices!.join("、")}（中间件复用服务器共享资源）`);
    const up = await this.sshExec(serverId, `cd "${srcDir}" && docker compose -p ${projectName}${overrideArg} up -d${upArg}`);
    await rlog(up.stdout + up.stderr);
    if (up.code !== 0) throw new ServiceError(`远端 compose up 失败（exit ${up.code}）`);

    // 5. 域名绑定 → edge 全量对账
    const domains = await this.edge.domainsOfTarget(target.id);
    if (domains.length > 0) {
      await log("同步 edge 路由与证书 …");
      await this.edge.syncServer(serverId, log);
    }

    await this.repo.updateTarget(target.id, { lastKnownSha: sha, updateAvailable: false });

    // 回滚原料（远端构建不产产物传输，artifactShipped 不置位——通道语义只属于本地构建路径）
    await this.snapshotRun({
      target, runId, serverId, project: projectName, log,
      compose: composeText,
      override: target.overrideCompose ? decryptSecret(target.overrideCompose) : "",
      env: target.envJson ? decryptSecret(target.envJson) : "",
      services: cfg.services,
    });
  }

  // ── db：模板 compose + .env 推远端 → up ──
  private async deployDb(target: DeployTarget, log: Log, runId: number) {
    if (!target.envJson) throw new ServiceError("数据库目标缺少模板内容");
    if (!target.containerName) throw new ServiceError("数据库目标缺少容器名（旧数据？重建该目标）");
    const rendered = JSON.parse(decryptSecret(target.envJson)) as { compose: string; env: string };
    const serverId = await this.nodeServerId(target);
    await this.preflightCheck(target, serverId, [target.containerName], log);
    const client = await this.serverService.ssh(serverId);
    const remoteDir = await this.resolveRemoteDir(client, target.remoteDir ?? `~/dockyard/${target.name}`);
    await client.exec(`mkdir -p ${remoteDir}`);
    const sftp = await openSftp(client);
    await sftp.write(`${remoteDir}/docker-compose.yml`, rendered.compose);
    await sftp.write(`${remoteDir}/.env`, rendered.env);
    await sftp.close();
    await log(`推送 ${target.dbType} 模板到 ${remoteDir}`);
    const up = await client.exec(`cd ${remoteDir} && docker compose up -d`);
    await log(up.stdout + up.stderr);
    if (up.code !== 0) throw new ServiceError(`远端 compose up 失败（exit ${up.code}）`);

    // 回滚原料：模板 compose/env 快照（官方镜像不变，无需打 tag）
    await this.snapshotRun({
      target, runId, serverId, log,
      compose: rendered.compose,
      override: "",
      env: rendered.env,
    });
  }

  /**
   * 部署成功收尾：compose/env/override 快照（enc1 加密落库）+ 镜像打 run tag。
   * 这是回滚的唯一原料；此处失败只记警告，绝不让成功的部署翻盘成失败。
   */
  private async snapshotRun(opts: {
    target: DeployTarget;
    runId: number;
    serverId: number;
    project?: string;
    compose: string;
    override: string;
    env: string;
    services?: Record<string, { image?: string }>;
    log: Log;
  }) {
    const { target, runId, serverId, log } = opts;
    try {
      const snapshotJson = encryptSecret(
        JSON.stringify({ compose: opts.compose, override: opts.override, env: opts.env }),
      );
      // 逐服务打 tag：dockyard-<targetId>-<svc>:run-<runId>（不动用户 compose 的镜像名）
      let imageSnapshot: Record<string, string> | undefined;
      if (opts.services) {
        imageSnapshot = {};
        for (const [svc, def] of Object.entries(opts.services)) {
          if (!def.image) continue;
          // upServices 子集外的服务本次没起来，跳过 pin（回滚时 pin 不存在的 tag 会让 up 拉取失败）
          if (target.upServices?.length && !target.upServices.includes(svc)) continue;
          const tag = `dockyard-${target.id}-${svc.toLowerCase()}:run-${runId}`;
          const r = await this.sshExec(serverId, `docker tag "${def.image}" "${tag}"`);
          if (r.code !== 0) {
            await log(`⚠️ 镜像快照 tag 失败（${svc}）：${r.stderr}`);
            continue;
          }
          imageSnapshot[svc] = tag;
        }
        if (!Object.keys(imageSnapshot).length) imageSnapshot = undefined;
      }
      await this.repo.updateDeployment(runId, {
        snapshotJson,
        imageSnapshot,
        ...(opts.project ? { project: opts.project } : {}),
      });
      await log("📸 已记录部署快照（可回滚）");
    } catch (error) {
      await log(`⚠️ 快照记录失败（不影响部署结果）：${(error as Error).message}`);
    }
  }

  /**
   * 回滚到某次成功部署：校验放 await 段（快照缺失/记录错位直接抛回 actions），
   * 之后才进 running Map（与 deploy 同锁，部署/回滚互斥）。
   */
  async rollback(targetId: number, runId: number): Promise<void> {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError(`部署目标不存在: ${targetId}`);
    const src = await this.repo.deploymentById(runId);
    if (!src || src.targetId !== targetId) throw new ServiceError(`部署记录不存在: ${runId}`);
    if (src.status !== "success" || !src.snapshotJson)
      throw new ServiceError("该记录缺少快照，无法回滚（仅本轮之后的部署会产生快照）");

    const hit = this.running.get(targetId);
    if (hit) return;
    const task = this.rollbackPipeline(target, src)
      .catch(() => { })
      .finally(() => this.running.delete(targetId));
    this.running.set(targetId, task);
    // 不返回 task：调用方 await 到的是「校验通过、已开播」，不是整个回滚过程
  }

  private async rollbackPipeline(target: DeployTarget, src: Deployment) {
    const targetId = target.id;
    const ch = CANVAS_CHANNEL;
    const dep = await this.repo.createDeployment(targetId, { trigger: "rollback", rollbackOf: src.id });
    const log = this.makeLog(dep.id, targetId);
    const setStatus = async (status: Deployment["status"], patch: Partial<Deployment> = {}) => {
      await this.repo.updateDeployment(dep.id, { status, ...patch });
      events.publish(ch, { type: "status", targetId, status });
    };

    events.publish(ch, { type: "running", targetId, running: true });
    events.publish(ch, { type: "status", targetId, status: "queued" });
    try {
      await setStatus("deploying", { commitSha: src.commitSha });
      await this.deployRollback(target, src, log);
      await setStatus("success", { finishedAt: new Date() });
      await log("✅ 回滚完成");
      // 回滚是「留旧版」的明确意图：auto 策略不降级的话，下一轮轮询会立刻把坏 sha 自动部回去
      if (target.deployPolicy === "auto") {
        await this.repo.updateTarget(targetId, { deployPolicy: "notify" });
        await log("⚠️ 部署策略已从「自动部署」降级为「仅提醒」——确认修复后可在抽屉里改回");
      }
      await this.repo.pruneRuns(targetId, RUNS_KEEP);
    } catch (error) {
      await log(`❌ ${(error as Error).message}`);
      await setStatus("failed", { finishedAt: new Date() });
    } finally {
      await log.flush();
      events.publish(ch, { type: "running", targetId, running: false });
    }
  }

  // ── 回滚执行：快照文件写独立回滚目录（不污染在跑的 remoteDir，更不弄脏远端 git 检出目录），
  //    有 imageSnapshot 时生成 pin 覆盖文件锁死旧镜像，up 时 -p 沿用当初项目名 ──
  private async deployRollback(target: DeployTarget, src: Deployment, log: Log) {
    const snapshot = JSON.parse(decryptSecret(src.snapshotJson!)) as {
      compose: string;
      override: string;
      env: string;
    };
    const serverId = await this.nodeServerId(target);
    const client = await this.serverService.ssh(serverId);
    const rollbackDir = await this.resolveRemoteDir(client, `~/dockyard/rollback/${target.id}`);
    await client.exec(`mkdir -p ${rollbackDir}`);
    const sftp = await openSftp(client);
    await sftp.write(`${rollbackDir}/docker-compose.yml`, snapshot.compose);
    if (snapshot.env) await sftp.write(`${rollbackDir}/.env`, snapshot.env);
    if (snapshot.override) await sftp.write(`${rollbackDir}/docker-compose.dockyard.yml`, snapshot.override);

    const files = ["-f docker-compose.yml"];
    if (snapshot.override) files.push("-f docker-compose.dockyard.yml");
    // 镜像 pin：up 用旧 tag，不触发 build / 拉新
    const pinned = Object.entries(src.imageSnapshot ?? {}).filter(
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
    const project = src.project ?? `dockyard-${target.id}`;
    const cfgOut = await this.sshExec(serverId, `cd ${rollbackDir} && docker compose ${files.join(" ")} config --format json`);
    if (cfgOut.code === 0) {
      const cfg = JSON.parse(cfgOut.stdout) as {
        services?: Record<string, { container_name?: string }>;
      };
      const names = Object.entries(cfg.services ?? {}).map(([svc, def]) => def.container_name ?? `${project}-${svc}-1`);
      if (names.length) await this.preflightCheck(target, serverId, names, log);
    }

    const upArg = target.upServices?.length ? ` ${target.upServices.join(" ")}` : "";
    await log(`回滚到 run #${src.id}（${src.commitSha ?? "无 sha"}）…`);
    const up = await this.sshExec(
      serverId,
      `cd ${rollbackDir} && docker compose -p ${project} ${files.join(" ")} up -d${upArg}`,
    );
    await log(up.stdout + up.stderr);
    if (up.code !== 0) throw new ServiceError(`回滚 compose up 失败（exit ${up.code}）`);

    const domains = await this.edge.domainsOfTarget(target.id);
    if (domains.length) {
      await log("同步 edge 路由与证书 …");
      await this.edge.syncServer(serverId, log);
    }
    // sha 回退到旧值：徽章与"有更新"语义跟着回滚走
    if (src.commitSha) await this.repo.updateTarget(target.id, { lastKnownSha: src.commitSha });
  }

  /** target → node → serverId（deploy 位于 canvas 之上，可直接查） */
  private async nodeServerId(target: DeployTarget): Promise<number> {
    const node = await this.canvas.byId(target.nodeId);
    if (!node) throw new ServiceError("画布节点已删除");
    return node.serverId;
  }

  /**
   * 「传输产物」独立动作：本地构建 + 推到远端，不起容器。
   * 用途 = 跨区移动前的显式通道（artifactShipped 置位）。建 run 行复用日志面板看进度。
   */
  async shipArtifact(targetId: number): Promise<void> {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError(`部署目标不存在: ${targetId}`);
    if (target.kind !== "app") throw new ServiceError("只有应用需要传输产物");
    const { type, project } = await this.sourceOf(target);
    if (type !== "local" || !project?.localPath)
      throw new ServiceError("只有本地导入的应用有「传输产物」——GitHub 导入在远端直接构建");
    if (this.running.has(targetId)) return;

    const task = (async () => {
      const ch = CANVAS_CHANNEL;
      const dep = await this.repo.createDeployment(targetId, { trigger: "ui" });
      const log = this.makeLog(dep.id, targetId);
      const setStatus = async (status: Deployment["status"], patch: Partial<Deployment> = {}) => {
        await this.repo.updateDeployment(dep.id, { status, ...patch });
        events.publish(ch, { type: "status", targetId, status });
      };
      events.publish(ch, { type: "running", targetId, running: true });
      try {
        const serverId = await this.nodeServerId(target);
        await this.shipLocalArtifact(target, project, serverId, log, setStatus);
        await setStatus("success", { finishedAt: new Date() });
        await log("✅ 产物已传输（容器未启动；可将卡移入远程区后部署）");
      } catch (error) {
        await log(`❌ ${(error as Error).message}`);
        await setStatus("failed", { finishedAt: new Date() });
      } finally {
        await log.flush();
        events.publish(ch, { type: "running", targetId, running: false });
      }
    })()
      .catch(() => { })
      .finally(() => this.running.delete(targetId));
    this.running.set(targetId, task);
  }

  /**
   * 卡迁移到另一台服务器（拖拽落位调这里）。
   * 区域硬隔离：local↔remote 跨界，app 必须 artifactShipped（产物已到云端），db 直接拒绝（数据不随卡走）。
   * 迁移后：groupId 清零（分组不跨服务器）；域名跟随 target → 新旧两台 edge 都对账；旧容器不自动清理（安全纪律）。
   */
  async moveTargetToNode(targetId: number, nodeId: number): Promise<void> {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError(`部署目标不存在: ${targetId}`);
    if (target.nodeId === nodeId) return; // 原地落位，无操作
    const node = await this.canvas.byId(nodeId);
    if (!node) throw new ServiceError("目标画布节点不存在");
    const oldNode = await this.canvas.byId(target.nodeId);
    if (!oldNode) throw new ServiceError("画布节点已删除");
    await this.assertNameFree(nodeId, target.kind, target.name);

    const [oldServer, newServer] = await Promise.all([
      this.serverService.byId(oldNode.serverId),
      this.serverService.byId(node.serverId),
    ]);
    const crossing = isLocalHost(oldServer?.host ?? "") !== isLocalHost(newServer?.host ?? "");
    if (crossing) {
      if (target.kind !== "app")
        throw new ServiceError("数据库不能跨区移动——数据不随卡走，请在目标服务器新建实例");
      if (!target.artifactShipped)
        throw new ServiceError("构建产物尚未传输到云端——先在服务抽屉执行「传输产物」");
    }

    await this.repo.updateTarget(targetId, { nodeId, groupId: null, x: null, y: null });
    const domains = await this.edge.domainsOfTarget(targetId);
    if (domains.length) {
      const noop: Log = async () => {};
      // 旧服务器撤路由、新服务器建路由，两边都对账
      if (oldServer) await this.edge.syncServer(oldServer.id, noop);
      if (newServer) await this.edge.syncServer(newServer.id, noop);
    }
  }
}
