// 部署形态注册表：六阶段前半段（源×构建×传输）的组合实现。
// 每个 compose 形态产出 Provision（零界点断言：远端目录就绪 + 镜像就绪），
// 后半段由 pipeline 的共享 activate/captureArtifact 承接；新增部署方式 = 在这里注册新形态。
// 逻辑库不穿零点（无产物），以 custom run 旁路实现。
//
// 行为保真红线：shell 命令文本/参数顺序/脱敏逻辑与原 deploy.service.ts 逐字一致。
import { ServiceError } from "@elysiax/core";
import { dirname, join, normalize } from "node:path";
import { Readable, Writable } from "node:stream";
import { decryptSecret } from "@/shared/crypto";
import { parseOwnerRepo } from "@/pages/github/github.socket";
import { openServerSftp } from "@/pages/servers/servers.socket";
import { logicalDbCommands, type DbType } from "@/pages/resources/resources.socket";
import type { Project } from "@/pages/projects/projects.socket";
import { composeInterpVars, envFilePaths, textToEnvMap } from "./detect";
import { fetchViaControlPlane, probeGithub, safeDirName } from "./source";
import {
  dockerArch,
  inspectCompose,
  run,
  type DeployForm,
  type Harness,
  type Provision,
  type StageCtx,
} from "./pipeline";

// ── app · GitHub 导入：远端服务器拉代码 → 服务器上构建镜像 → 免传输（就地就绪）──
export const githubAppForm: DeployForm = {
  name: "github-app",
  async provision(ctx: StageCtx, h: Harness): Promise<Provision> {
    const { target, log } = ctx;
    if (!target.repoUrl)
      throw new ServiceError("GitHub 导入的部署目标缺少 repoUrl");
    const ownerRepo = parseOwnerRepo(target.repoUrl);
    const branch = target.branch ?? "main";
    const serverId = await h.nodeServerId(target);
    const client = await h.serverService.transport(serverId);
    const authedUrl = await h.github.authedRepoUrl(ownerRepo);
    // git 报错会把整条带 token 的 URL 打进 stderr——所有日志/异常先脱敏
    const cred = authedUrl.match(/^https:\/\/([^@]+)@/)?.[1];
    const redact = (s: string) => (cred ? s.split(cred).join("***") : s);
    const rlog = async (s: string) => log(redact(s));
    const srcDir = await h.resolveRemoteDir(
      client,
      `~/dockyard/src/${target.id}-${safeDirName(target.name)}`,
    );
    const composePath = target.composePath ?? "docker-compose.yml";

    // 1. 源：拉代码。
    //
    // 两种取码路径：
    //   a) 远端直连 GitHub（海外服务器 / 有代理的国内服务器）——git clone / fetch
    //   b) 控制面代理（国内服务器连不上 GitHub 时）——控制面下载 tarball，
    //      经 SFTP 推给远端解包，远端全程不碰 GitHub
    //
    // 判定：先探远端到 GitHub 的连通性（HEAD 请求，5s 超时）；
    // 不通就走 (b)，省掉三次注定失败的 git 尝试。
    await ctx.setStatus("building");
    await ctx.setStage("sourcing");
    const remoteReachable = await probeGithub(client);
    if (!remoteReachable) {
      await rlog(
        `远端连不上 GitHub，改由控制面代理取码：控制面下载 → 推送远端`,
      );
    }
    const probe = await client.exec(
      `[ -d "${srcDir}/.git" ] && echo yes || echo no`,
    );
    if (probe.stdout.trim() !== "yes") {
      if (remoteReachable) {
        await rlog(`远端克隆 ${ownerRepo} …`);
        await client.exec(`mkdir -p "$(dirname "${srcDir}")"`);
        const clone = await client.exec(
          `git -c http.version=HTTP/1.1 clone --branch "${branch}" --single-branch "${authedUrl}" "${srcDir}"`,
        );
        if (clone.code !== 0)
          throw new ServiceError(
            redact(`远端克隆失败（exit ${clone.code}）\n${clone.stderr}`),
          );
        await client.exec(
          `git -C "${srcDir}" remote set-url origin "https://github.com/${ownerRepo}.git"`,
        );
      } else {
        await rlog(`控制面下载 ${ownerRepo}@${branch} …`);
        await fetchViaControlPlane(h, client, {
          ownerRepo,
          branch,
          srcDir,
          log: rlog,
        });
      }
    }
    // ── 取码：判定「有没有更新」放在控制面，远端只负责取 ──
    // 远端服务器到 GitHub 的链路不稳（TLS 抖动会打断整轮部署），
    // 而控制面（本地）问 GitHub 是可靠的。所以：控制面查上游最新 sha，
    // 与远端现有检出比对——相同就复用缓存（完全不碰远端→GitHub 链路），
    // 不同才让远端 fetch。手动重部署同样走这条路径，不再依赖 updateAvailable 徽章。
    // 远端工作目录可能没有 .git（控制面代理解包的目录）——那时读标记文件
    const revParse = await client.exec(
      `git -C "${srcDir}" rev-parse --short=8 HEAD 2>/dev/null || cat "${srcDir}/.dockyard-sha" 2>/dev/null || true`,
    );
    const currentSha = revParse.stdout.trim();
    let upstreamShort: string | null = null;
    try {
      const head = await h.github.latestSha(ownerRepo, branch);
      upstreamShort = head ? head.sha.slice(0, 8) : null;
    } catch (error) {
      await rlog(`⚠️ 查询上游最新提交失败：${(error as Error).message}`);
    }
    // upstreamShort 拿不到（GitHub 不可达/限流）时按「可能有更新」处理：
    // 宁可多 fetch 一次，也不要在有更新时拿旧代码构建。
    const needFetch = !upstreamShort || upstreamShort !== currentSha;
    // stale = 本轮构建用的不是上游最新提交（拉取失败降级时为 true）
    let stale = false;
    if (!needFetch) {
      await rlog(`远端已是上游最新提交 ${currentSha}，复用现有检出`);
    } else if (!remoteReachable) {
      // 远端连不上 GitHub → 由控制面下载快照推过去（远端零 GitHub 依赖）
      await rlog(
        upstreamShort
          ? `控制面下载上游 ${upstreamShort}（远端现有 ${currentSha}）…`
          : "控制面下载上游最新快照…",
      );
      try {
        await fetchViaControlPlane(h, client, {
          ownerRepo,
          branch,
          srcDir,
          log: rlog,
          sha: upstreamShort ?? undefined,
        });
      } catch (error) {
        stale = true;
        await rlog(
          `⚠️ 控制面代理取码失败（${(error as Error).message}），本轮沿用远端现有检出 ${currentSha}`,
        );
      }
    } else {
      await rlog(
        upstreamShort
          ? `拉取上游最新提交 ${upstreamShort}（远端现有 ${currentSha}）…`
          : "未能确认上游版本，拉取远端分支最新提交…",
      );
      // 瞬时网络抖动（TLS 断连）重试；三次都失败不再打死整轮——
      // 退回远端现有检出继续构建，并在日志与 UI 上明确标注「构建的不是最新提交」。
      let fetched = false;
      for (let attempt = 1; attempt <= 3 && !fetched; attempt++) {
        const fetch = await client.exec(
          // http.version=HTTP/1.1：远端 git 走 HTTP/2 时常报
          // "RPC failed; curl 16 Error in the HTTP2 framing layer"，降到 1.1 即可稳定。
          // 用 -c 单次生效，不写进仓库配置。
          //
          // http.lowSpeedLimit/Time：国内服务器到 GitHub 链路慢时，git 默认 30s 无数据就
          // 判定传输失败（"The remote end hung up unexpectedly"）。放宽到「60s 至少 1 字节」
          // 让慢链路能熬过去，而不是直接掐断。
          `git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1 -c http.lowSpeedTime=60` +
            ` -C "${srcDir}" fetch --no-tags --depth=1 "${authedUrl}" "${branch}"` +
            ` && git -C "${srcDir}" checkout --force --detach FETCH_HEAD`,
        );
        fetched = fetch.code === 0;
        if (!fetched) {
          // 每次失败都把原始输出打出来：之前只在最后一次打印，且截断 300 字，
          // 用户既看不到「第几次失败的」也看不到完整错误（限速/代理/证书的真实原因）。
          const detail = (fetch.stderr || fetch.stdout || "").trim();
          await rlog(
            `拉取失败（exit ${fetch.code}）${attempt < 3 ? "，重试…" : ""}` +
              (detail ? `\n${detail}` : "（无输出）"),
          );
        }
      }
      if (!fetched) {
        stale = true;
        await rlog(`⚠️ 三次拉取均失败，本轮沿用远端现有检出 ${currentSha}`);
      }
    }
    // 构建用的提交号：控制面代理模式下远端没有 .git，读标记文件
    const sha = (
      await client.exec(
        `git -C "${srcDir}" rev-parse --short=8 HEAD 2>/dev/null || cat "${srcDir}/.dockyard-sha" 2>/dev/null || echo unknown`,
      )
    ).stdout.trim();
    await rlog(`远端构建 ${ownerRepo}@${sha} …`);

    // 2. env_file 占位（compose config/build 要求文件存在；真实值由 override/.env 注入）。
    // compose 把 env_file 解析为「相对 compose 文件所在目录」，子目录 compose（deploy/x.yml 写 ../apps/.env）必须同样解析
    const composeText = (await client.exec(`cat "${srcDir}/${composePath}"`))
      .stdout;
    await reportMissingInterpVars(composeText, target.envJson, rlog, [
      ...(target.serviceName ? [target.serviceName] : []),
      ...(target.upServices ?? []),
    ]);
    for (const p of envFilePaths(composeText)) {
      const rel = normalize(join(dirname(composePath), p));
      if (rel.startsWith("..") || rel.startsWith("/")) continue; // 逃出仓库的路径不创建
      await client.exec(
        `cd "${srcDir}" && mkdir -p "$(dirname "${rel}")" && [ -f "${rel}" ] || printf '# dockyard 占位\\n' > "${rel}"`,
      );
    }

    // 3. 构建边界 = 单服务 target。没有 build 的 postgres/redis 只拉镜像，绝不执行 compose build。
    // 多服务旧 target 保留串行全量构建；新服务级部署不会进入这个分支。
    const selectedConfig = target.serviceName
      ? await client.exec(
          `cd "${srcDir}" && docker compose -f "${composePath}" config --format json`,
        )
      : undefined;
    if (selectedConfig && selectedConfig.code !== 0)
      throw new ServiceError(
        redact(`远端 compose config 失败：${selectedConfig.stderr}`),
      );
    const selectedService = selectedConfig
      ? (
          JSON.parse(selectedConfig.stdout) as {
            services?: Record<string, { build?: unknown }>;
          }
        ).services?.[target.serviceName!]
      : undefined;
    if (target.serviceName && !selectedService)
      throw new ServiceError(`compose 中不存在服务「${target.serviceName}」`);
    // 4. 归属校验 + 秘密落盘：compose config 解析 → 容器归属对账 → 写 .env/override/labels。
    // 顺序刻意如此：秘密文件必须在归属校验通过后才写（不能被抢先覆盖别人的目录）；
    // 但必须排在 build 之前——compose 的 ${VAR} 插值在解析 YAML 时就发生，.env 晚到
    // 会让 build.args / environment 拿到空串，且日志里刷一堆「variable is not set」。
    const inspected = await inspectCompose(h, {
      target,
      serverId,
      remoteDir: srcDir,
      composeFile: composePath,
      hasOverride: Boolean(target.overrideCompose),
      log,
      redact,
    });

    const fresh = await h.serverService.transport(serverId);
    const sftp = await openServerSftp(fresh);
    if (inspected.labelsCompose)
      await sftp.write(
        `${srcDir}/docker-compose.dockyard-labels.yml`,
        inspected.labelsCompose,
      );
    // .env 必须落在 compose 文件所在目录：docker compose 的 ${VAR} 插值只读
    // 「第一个 -f 所在目录/.env」；子目录 compose（deploy/docker-compose.yml）写 remoteDir 根读不到
    if (target.envJson) {
      await sftp.write(
        `${join(srcDir, dirname(composePath))}/.env`,
        decryptSecret(target.envJson),
      );
      // 旧版本把 .env 写在 remoteDir 根（子目录 compose 读不到）——清掉，避免两份不同步误导排查
      if (dirname(composePath) !== ".")
        await fresh.exec(`rm -f "${srcDir}/.env"`);
    }
    if (target.overrideCompose)
      await sftp.write(
        `${srcDir}/docker-compose.dockyard.yml`,
        decryptSecret(target.overrideCompose),
      );
    // app 级 .env 的容器注入层：本次有变量就写，没有就删掉上次残留（-f 已不再引用它）
    if (inspected.appEnvCompose)
      await sftp.write(
        `${srcDir}/docker-compose.dockyard-env.yml`,
        inspected.appEnvCompose,
      );
    else
      await fresh.exec(`rm -f "${srcDir}/docker-compose.dockyard-env.yml"`);
    await sftp.close();

    // 秘密落盘后复验：compose 的 `${VAR:?}` 是硬依赖（缺值直接解析失败），
    // 而上面的 inspectCompose 必须在 .env 之前跑（它同时是归属校验）。
    // 这里再解析一次，让「变量没配」表现为一条中文报错，而不是等到 build/up 才炸。
    const recheck = await fresh.exec(
      `cd "${srcDir}" && docker compose -f "${composePath}" config --format json`,
    );
    if (recheck.code !== 0)
      throw new ServiceError(
        redact(
          `compose 解析失败（.env 已写入）：${recheck.stderr}\n` +
            `常见原因：compose 用了 \${VAR:?} 但变量里没有该键`,
        ),
      );

    await ctx.setStage("building");
    if (target.serviceName && !selectedService?.build) {
      await rlog(`服务 ${target.serviceName} 使用现成镜像，跳过构建`);
      const pull = await h.execLongRemote(
        serverId,
        `cd "${srcDir}" && docker compose -f "${composePath}" pull "${target.serviceName}"`,
        `pull-${target.id}`,
        rlog,
      );
      if (pull.code !== 0)
        throw new ServiceError(`远端镜像拉取失败（exit ${pull.code}）`);
    } else {
      const buildCmd = target.serviceName
        ? `docker compose -f "${composePath}" build "${target.serviceName}"`
        : `for s in $(docker compose -f "${composePath}" config --services); do docker compose -f "${composePath}" build "$s" || exit 1; done`;
      const build = await h.withBuildLock(
        serverId,
        () =>
          h.execLongRemote(
            serverId,
            `cd "${srcDir}" && ${buildCmd}`,
            `build-${target.id}`,
            rlog,
          ),
        rlog,
      );
      if (build.code !== 0)
        throw new ServiceError(`远端构建失败（exit ${build.code}）`);
    }

    return {
      remoteDir: srcDir,
      ...inspected,
      upServices: target.serviceName
        ? [target.serviceName]
        : (target.upServices ?? undefined),
      sha,
      // 拉取失败降级：构建的不是上游最新提交 → 徽章保持「有更新」
      shaStale: stale || undefined,
      log: rlog, // up 段日志保持脱敏纪律
      snapshot: {
        compose: composeText,
        override: target.overrideCompose
          ? decryptSecret(target.overrideCompose)
          : "",
        env: target.envJson ? decryptSecret(target.envJson) : "",
        appEnv: inspected.appEnvCompose ?? "",
      },
    };
  },
};

// ── app · 本地文件夹导入：本地构建 → docker save → 远端 load → sftp 推 compose ──
// provision 同时是「传输产物」独立动作的本体：本地构建 + 推到远端，不起容器。
// 成功即置 artifactShipped——这是本地卡跨区移动的唯一门票（区域硬隔离的显式通道）。
export function localAppForm(proj: Project): DeployForm {
  return {
    name: "local-app",
    async provision(ctx: StageCtx, h: Harness): Promise<Provision> {
      const { target, log } = ctx;
      const serverId = await h.nodeServerId(target);
      const repoDir = join(proj.localPath!, proj.rootDir ?? "");
      await ctx.setStatus("building");
      await ctx.setStage("sourcing");
      const shaProc = Bun.spawn(["git", "rev-parse", "--short=8", "HEAD"], {
        cwd: repoDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const sha =
        (await new Response(shaProc.stdout).text()).trim() ||
        `local-${Date.now()}`;

      const composePath = target.composePath ?? "docker-compose.yml";
      const composeBase = ["docker", "compose", "-f", composePath];

      // 1. 构建：本地 build。跨架构：远端是 arm64 而本机 amd64 时，必须经 buildx 出对应平台镜像——
      // 经典 builder 会静默忽略 DOCKER_DEFAULT_PLATFORM，产出本机架构镜像，远端起不来还难查
      // 平台：target.buildPlatform 显式指定优先，否则远端架构与本机不同才跨架构构建
      const caps = await h.serverCaps(serverId);
      const platform =
        target.buildPlatform ??
        (caps.arch === dockerArch(process.arch)
          ? undefined
          : `linux/${caps.arch}`);
      let env: Record<string, string> | undefined;
      if (platform) {
        const buildx = Bun.spawn(["docker", "buildx", "version"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        if ((await buildx.exited) !== 0)
          throw new ServiceError(
            `远端架构需要 ${platform} 镜像，但本机没有 docker buildx——请安装 Docker Buildx 插件`,
          );
        await log(`跨架构构建 ${platform}（本机 ${process.arch} → 远端）…`);
        env = { DOCKER_DEFAULT_PLATFORM: platform };
      }
      await log(`本地构建 ${repoDir} @${sha} …`);
      await ctx.setStage("building");
      await run(
        [
          ...composeBase,
          "build",
          ...(target.serviceName ? [target.serviceName] : []),
        ],
        repoDir,
        log,
        env,
      );

      // 用户决定怎么打包：镜像名从 compose 配置里读
      const imgProc = Bun.spawn(
        [
          ...composeBase,
          "config",
          "--images",
          ...(target.serviceName ? [target.serviceName] : []),
        ],
        { cwd: repoDir, stdout: "pipe" },
      );
      const images = (await new Response(imgProc.stdout).text())
        .trim()
        .split("\n")
        .filter(Boolean);
      if (images.length === 0)
        throw new ServiceError("compose 没有产生任何镜像");

      // 2. 传输：docker save → dockerode 经 SSH relay load 到远端。
      // 本机目标共用同一个 daemon：构建完镜像已经在那儿，save/load 纯属自搬自（大镜像白耗分钟级）
      await ctx.setStage("transferring");
      await ctx.setStatus("transferring", { commitSha: sha });
      const server = await h.serverService.byId(serverId);
      // builtin 是唯一真相：回环地址上的用户 SSH 隧道走远程通道，daemon 不是同一个
      const sameDaemon = server?.builtin === true;
      const remote = await h.serverService.docker(serverId);
      for (const image of images) {
        if (sameDaemon) {
          await log(`镜像 ${image} 已在本机 daemon，跳过传输`);
          continue;
        }
        await log(`传输镜像 ${image} …`);
        const save = Bun.spawn(["docker", "save", image], { stdout: "pipe" });
        // dockerode 要 Node stream；Bun.stdout 是 Bun 扩展的 Web stream（类型不完全重合）
        await remote.loadImage(
          Readable.fromWeb(
            save.stdout as unknown as import("node:stream/web").ReadableStream,
          ),
        );
        if ((await save.exited) !== 0)
          throw new ServiceError(`docker save 失败: ${image}`);
        await log(`已传输 ${image}`);
      }
      // 门票升维：布尔 + 落点 serverId（换服务器必须重传——镜像只 load 在当次目标上）
      await h.repo.updateTarget(target.id, {
        artifactShipped: true,
        artifactServerId: serverId,
      });

      // 3. 传输（配置）：compose/.env/override 推远端工作目录
      const client = await h.serverService.transport(serverId);
      const remoteDir = await h.resolveRemoteDir(
        client,
        target.remoteDir ?? `~/dockyard/${target.name}`,
      );
      await client.exec(`mkdir -p "${remoteDir}"`);
      const sftp = await openServerSftp(client);
      const composeText = await Bun.file(join(repoDir, composePath)).text();
      await reportMissingInterpVars(composeText, target.envJson, log, [
        ...(target.serviceName ? [target.serviceName] : []),
        ...(target.upServices ?? []),
      ]);
      await sftp.write(`${remoteDir}/docker-compose.yml`, composeText);
      // 用户 compose 的 env_file 是相对仓库的路径（远端没有目录树）——放空占位，
      // 否则 compose config/up 直接报 "env file not found"；真实值由 override 的 environment 注入
      for (const p of envFilePaths(composeText)) {
        // 逃出工作目录的路径不创建（与 githubAppForm 同一道守卫）：
        // `env_file: ../../etc/x` 会把占位文件写到 remoteDir 之外
        const rel = normalize(p);
        if (rel.startsWith("..") || rel.startsWith("/")) continue;
        await client.exec(
          `cd "${remoteDir}" && mkdir -p "${join(".", p, "..")}" && [ -f "${p}" ] || printf '# dockyard 占位：真实环境变量在 docker-compose.dockyard.yml 的 environment 里\\n' > "${p}"`,
        );
      }

      // 4. 产物断言核验（config 解析 + preflight 门禁）：compose 占位已写（核验所需），
      // 秘密文件（.env/override）必须校验通过后才写
      const inspected = await inspectCompose(h, {
        target,
        serverId,
        remoteDir,
        composeFile: "docker-compose.yml",
        hasOverride: Boolean(target.overrideCompose),
        log,
      });

      // 5. 传输（秘密 + 归属标签）：.env/override/labels 推远端
      if (inspected.labelsCompose)
        await sftp.write(
          `${remoteDir}/docker-compose.dockyard-labels.yml`,
          inspected.labelsCompose,
        );
      if (target.envJson)
        await sftp.write(`${remoteDir}/.env`, decryptSecret(target.envJson));
      // 识别出的资源限制/服务级 environment 以 override compose 叠加（不改用户原 compose）
      if (target.overrideCompose)
        await sftp.write(
          `${remoteDir}/docker-compose.dockyard.yml`,
          decryptSecret(target.overrideCompose),
        );
      // app 级 .env 的容器注入层：本次有变量就写，没有就删掉上次残留（-f 已不再引用它）
      if (inspected.appEnvCompose)
        await sftp.write(
          `${remoteDir}/docker-compose.dockyard-env.yml`,
          inspected.appEnvCompose,
        );
      else
        await client.exec(
          `rm -f "${remoteDir}/docker-compose.dockyard-env.yml"`,
        );
      await sftp.close();

      // 秘密落盘后复验（同 github 流程）：让 compose 的硬依赖变量缺失在部署前暴露
      const recheck = await client.exec(
        `cd "${remoteDir}" && docker compose -f "docker-compose.yml" config --format json`,
      );
      if (recheck.code !== 0)
        throw new ServiceError(
          `compose 解析失败（.env 已写入）：${recheck.stderr}\n` +
            `常见原因：compose 用了 \${VAR:?} 但变量里没有该键`,
        );

      return {
        remoteDir,
        ...inspected,
        upServices: target.serviceName
          ? [target.serviceName]
          : (target.upServices ?? undefined),
        sha,
        snapshot: {
          compose: composeText,
          override: target.overrideCompose
            ? decryptSecret(target.overrideCompose)
            : "",
          env: target.envJson ? decryptSecret(target.envJson) : "",
          appEnv: inspected.appEnvCompose ?? "",
        },
      };
    },
  };
}

/**
 * 部署前对账：compose 引用的插值变量 vs 目标变量。
 *
 * 为什么需要：`docker compose` 解析 YAML 时就把 `${X}` 就地替换，缺值只打一行英文警告并
 * 用空串顶上。构建阶段缺值通常无害（不启动容器），但 up 阶段缺值会让服务拿到空配置，
 * 而用户只看得到「我明明填了 DATABASE_URL」——缺的其实是另一个键（如 POSTGRES_PASSWORD）。
 * 这里提前算差集，用中文点名，别让人去翻 compose 源码。
 */
async function reportMissingInterpVars(
  composeText: string,
  envJson: string | null | undefined,
  log: (chunk: string) => Promise<void> | void,
  serviceNames?: string[],
): Promise<string[]> {
  const referenced = composeInterpVars(composeText, serviceNames);
  if (!referenced.length) return [];
  const have = new Set(
    Object.keys(textToEnvMap(envJson ? decryptSecret(envJson) : "")),
  );
  const missing = referenced.filter((k) => !have.has(k));
  if (missing.length)
    await log(
      `⚠️ compose 引用但变量里没有：${missing.join("、")}` +
        `（缺值会被替换成空串；在「变量」里补上，或给 compose 写默认值 \${X:-default}）`,
    );
  return missing;
}

// ── db · 独立实例：模板渲染 → sftp 推送 → compose up（官方镜像由 up 拉取，无构建、无 tag）──
export const dbContainerForm: DeployForm = {
  name: "db-container",
  async provision(ctx: StageCtx, h: Harness): Promise<Provision> {
    const { target } = ctx;
    if (!target.envJson) throw new ServiceError("数据库目标缺少模板内容");
    if (!target.containerName)
      throw new ServiceError("数据库目标缺少容器名（旧数据？重建该目标）");
    // 模板渲染 = 本形态的「源」段
    await ctx.setStage("sourcing");
    // project 是渲染时写入的项目名（新模板有顶层 name:；存量模板没有 = undefined，沿用目录名）
    const rendered = JSON.parse(decryptSecret(target.envJson)) as {
      compose: string;
      env: string;
      project?: string;
    };
    const serverId = await h.nodeServerId(target);
    // preflight 门禁在任何写入之前：被阻止时绝不能覆盖在跑实例目录里的 compose/.env
    await h.preflightCheck(target, serverId, [target.containerName], ctx.log);
    const client = await h.serverService.transport(serverId);
    const remoteDir = await h.resolveRemoteDir(
      client,
      target.remoteDir ?? `~/dockyard/${target.name}`,
    );
    await client.exec(`mkdir -p "${remoteDir}"`);
    // sftp 推送 = 本形态的「传输」段（无构建：官方镜像由 up 拉取）
    await ctx.setStage("transferring");
    const sftp = await openServerSftp(client);
    await sftp.write(`${remoteDir}/docker-compose.yml`, rendered.compose);
    await sftp.write(`${remoteDir}/.env`, rendered.env);
    await sftp.close();
    await ctx.log(`推送 ${target.dbType} 模板到 ${remoteDir}`);

    return {
      remoteDir,
      // 项目名由模板顶层 name: 定死（渲染时落库），目录名不再参与；
      // 显式传入只为了让产物记住它——回滚时 -p 与当初一致。
      // 存量模板无此字段 = 旧行为（项目名 = 目录名），不会因升级而换项目名
      project: rendered.project,
      containerNames: [target.containerName],
      composeArgs: "",
      // 模板不构建、镜像/配置都没变：重部署不该把数据库容器重建重启
      forceRecreate: false,
      snapshot: { compose: rendered.compose, override: "", env: rendered.env },
    };
  },
};

// ── db · 逻辑库（旁路，不穿零点）：不起容器，在宿主实例里 CREATE DATABASE + 专属账号 ──
export const dbLogicalForm: DeployForm = {
  name: "db-logical",
  async run(ctx: StageCtx, h: Harness): Promise<void> {
    const { target, log } = ctx;
    const instance = await h.repo.targetById(target.instanceOf!);
    if (!instance?.containerName)
      throw new ServiceError("宿主实例不存在或缺少容器名");
    const serverId = await h.nodeServerId(instance);
    const remote = await h.serverService.docker(serverId);

    const containers = await remote.listContainers({ all: true });
    const hit = containers.find((c) =>
      c.Names.includes(`/${instance.containerName}`),
    );
    if (!hit)
      throw new ServiceError(
        `宿主实例容器 ${instance.containerName} 不存在，请先部署实例「${instance.name}」`,
      );
    if (
      hit.Labels?.["dockyard.managed"] !== "true" ||
      hit.Labels?.["dockyard.target-id"] !== String(instance.id)
    )
      throw new ServiceError(
        `宿主实例容器 ${instance.containerName} 标签校验失败（非本工具创建），已阻止`,
      );
    if (hit.State !== "running")
      throw new ServiceError(
        `宿主实例「${instance.name}」未运行（${hit.State}）`,
      );

    const creds = JSON.parse(decryptSecret(target.envJson!)) as {
      url: string;
      password: string;
    };
    const cmds = logicalDbCommands(
      instance.dbType as DbType,
      target.name,
      creds.password,
    );
    const container = remote.getContainer(hit.Id);
    const execIn = async (
      cmd: string[],
    ): Promise<{ code: number; output: string }> => {
      // 不开 Tty：psql 检测到 TTY 会起 pager（less）把 exec 挂死。
      // hijack + demuxStream 拆多路复用的 stdout/stderr。
      const ex = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
      });
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
      remote.modem.demuxStream(
        stream,
        collect((s) => (out += s)),
        collect((s) => (err += s)),
      );
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
      const prev = await h.repo.lastSuccessfulDeployment(target.id);
      if (prev?.status === "success") {
        await log(`逻辑库 ${target.name} 已存在（上次部署创建），跳过`);
        return;
      }
      throw new ServiceError(
        `实例「${instance.name}」中已存在名为 ${target.name} 的库且非本工具创建，已阻止`,
      );
    }

    await log(`在实例「${instance.name}」中创建逻辑库 ${target.name} …`);
    for (const cmd of cmds.create) {
      const created = await execIn(cmd);
      if (created.code !== 0)
        throw new ServiceError(`创建逻辑库失败：${created.output}`);
    }
    // 日志里不出现明文密码
    await log(`连接串：${creds.url.replace(creds.password, "****")}`);
  },
};
