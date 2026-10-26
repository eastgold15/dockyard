import { status, t } from "elysia";
import { defineRoutes } from "../../../.elysiax";
import { LOGICAL_DB_SUPPORT, type DbType, type ResourceService, type SharedEnv } from "../resources/resources.socket";
import { type GithubService, type RepoBrief } from "../github/github.socket";
import { type CanvasService } from "../canvas/canvas.socket";
import { type ProjectService } from "../projects/projects.socket";
import { type EdgeService } from "../edge/edge.socket";
import { RuntimeService } from "./runtime/runtime.socket";
import { BackupService } from "./backup/backup.socket";
import {
  detectLocal,
  detectRepo,
  detectToEnvText,
  detectToOverrideCompose,
  guessDbType,
  type DetectedService,
} from "./detect";
import type { DeployService } from "./deploy.service";

/** 共享资源匹配（部署前置检查）：识别出的中间件服务 vs 目标服务器的共享资源清单 */
export type SharedMatch = { service: string; displayUrl: string } & SharedEnv;

async function sharedMatchesOf(
  di: { get(name: string): any },
  nodeId: number,
  services: DetectedService[],
): Promise<SharedMatch[]> {
  const node = await (di.get("canvasService") as CanvasService).byId(nodeId);
  if (!node) return [];
  const shared: SharedEnv[] = await (di.get("resourceService") as ResourceService).sharedEnvOf(node.serverId);
  return services.flatMap((s) => {
    const dbType = guessDbType(s);
    const hit = dbType ? shared.find((sh) => sh.dbType === dbType) : undefined;
    return hit
      ? [{ service: s.name, ...hit, displayUrl: hit.url.replace(/(\/\/[^:/@]+:)[^@]+(@)/, "$1•••$2") }]
      : [];
  });
}

/** Console 会话：ws 连接 → docker exec TTY 流（close 时必须 end，否则远端 sh 残留） */
const consoleSessions = new Map<unknown, { exec: { resize(dims: { h: number; w: number }): Promise<unknown> }; stream: { write(d: string): unknown; end(): unknown; on(ev: string, fn: (c: Buffer) => void): unknown } }>();

interface Ctx {
  deploy: DeployService;
  runtime: RuntimeService;
  backup: BackupService;
  edge: EdgeService;
  github: GithubService;
  canvas: CanvasService;
  project: ProjectService;
}

const ctxOf = (di: {
  get(k: "deployService"): DeployService;
  get(k: "runtimeService"): RuntimeService;
  get(k: "backupService"): BackupService;
  get(k: "edgeService"): EdgeService;
  get(k: "githubService"): GithubService;
  get(k: "canvasService"): CanvasService;
  get(k: "projectService"): ProjectService;
}): Ctx => ({
  deploy: di.get("deployService"),
  runtime: di.get("runtimeService"),
  backup: di.get("backupService"),
  edge: di.get("edgeService"),
  github: di.get("githubService"),
  canvas: di.get("canvasService"),
  project: di.get("projectService"),
});

const TABS = ["deployments", "source", "hardware", "network", "env", "monitor", "console", "backups"] as const;

const svcEditSchema = t.Object({
  name: t.String(),
  exposed: t.Boolean(),
  port: t.Optional(t.Number()),
  domain: t.Optional(t.String()),
  cpuCores: t.Optional(t.Number()),
  memoryMb: t.Optional(t.Number()),
  // env 值是 { value, secret } 结构（EnvValue/OpenshipEnvValue），不是裸字符串
  env: t.Record(t.String(), t.Object({ value: t.String(), secret: t.Boolean() })),
});

export default defineRoutes()
  // 向导数据：gh CLI 列出账号仓库做选择器（gh 未登录时降级为空列表手填）；
  // 本地文件夹导入的项目直接给出识别结果（跳过仓库选择步）
  .get("/new-app/:nodeId", { params: t.Object({ nodeId: t.Number() }) }, async ({ di, params }) => {
    const ctx = ctxOf(di);
    // 世界地图：节点不再携带项目——从卡上已有 target 的归属推项目（新卡无归属则按通用 github 流程）
    const nodeTargets = await ctx.deploy.targetsOfNode(params.nodeId);
    const nodeProjectId = nodeTargets.find((t) => t.projectId)?.projectId;
    const project = nodeProjectId ? await ctx.project.byId(nodeProjectId) : undefined;
    const isLocal = project?.sourceType === "local" || (!!project?.localPath && !project?.repoUrl);
    if (isLocal && project?.localPath) {
      const detect = await detectLocal({ localPath: project.localPath, rootDir: project.rootDir ?? undefined });
      const dbRefs = await ctx.deploy.dbRefsOfNode(params.nodeId);
      const sharedMatches = await sharedMatchesOf(di, params.nodeId, detect.services);
      return {
        mode: "local" as const,
        carry: {
          nodeId: params.nodeId,
          name: project.slug,
          repoUrl: project.repoUrl ?? "",
          branch: project.branch ?? "main",
          remoteDir: `~/dockyard/${project.slug}`,
        },
        detect,
        envText: detectToEnvText(detect),
        dbRefs,
        sharedMatches,
      };
    }
    let repos: RepoBrief[] = [];
    let ghError: string | undefined;
    try {
      repos = await ctx.github.listRepos();
    } catch (e) {
      ghError = `仓库列表拉取失败（${(e as Error).message}），可手动输入 owner/repo`;
    }
    // 项目 = 仓库：预填项目绑定的 repoUrl（仍可改——同一仓库可以多方式部署）
    return { mode: "github" as const, repos, error: ghError, prefillRepo: project?.repoUrl ?? undefined };
  })
  // 向导 step1 → step2：克隆仓库，读 openship.json / compose 自动识别
  .post(
    "/detect",
    {
      body: t.Object({
        nodeId: t.Number(),
        name: t.String({ minLength: 1 }),
        repoUrl: t.String({ minLength: 1 }),
        branch: t.String({ default: "main" }),
        remoteDir: t.String({ minLength: 1 }),
      }),
    },
    async ({ di, body }) => {
      // 识别失败：parseOwnerRepo 抛 ServiceError，框架统一映射（actions 不写 try/catch 回显）
      const detect = await detectRepo(ctxOf(di).github, body);
      const dbRefs = await ctxOf(di).deploy.dbRefsOfNode(body.nodeId);
      const sharedMatches = await sharedMatchesOf(di, body.nodeId, detect.services);
      return { carry: body, detect, envText: detectToEnvText(detect), dbRefs, sharedMatches };
    },
  )
  .get("/new-db/:nodeId", { params: t.Object({ nodeId: t.Number() }) }, async ({ di, params }) => ({
    instances: await ctxOf(di).deploy.instancesOfNode(params.nodeId, "postgres"),
  }))
  // dbType 切换时拉取该服务器上可托管的同类型实例（redis 不支持逻辑库）
  // query 显式声明（Eden 客户端类型需要）
  .get(
    "/instances",
    { query: t.Object({ nodeId: t.Numeric(), dbType: t.Optional(t.String()) }) },
    async ({ di, query }) => {
      const dbType = (query.dbType ?? "postgres") as DbType;
      const instances = LOGICAL_DB_SUPPORT[dbType]
        ? await ctxOf(di).deploy.instancesOfNode(query.nodeId, dbType)
        : [];
      return { instances };
    },
  )
  .post(
    "/targets/app",
    {
      body: t.Object({
        nodeId: t.Number(),
        name: t.String({ minLength: 1 }),
        repoUrl: t.Optional(t.String()),
        branch: t.String({ default: "main" }),
        composePath: t.String({ default: "docker-compose.yml" }),
        remoteDir: t.String({ minLength: 1 }),
        envText: t.Optional(t.String()),
        services: t.Array(svcEditSchema),
        depIds: t.Array(t.Number()),
        reuse: t.Array(t.String()),
      }),
    },
    async ({ di, body }) => {
      const svc = ctxOf(di).deploy;
      const services: DetectedService[] = body.services.map((s) => ({
        name: s.name,
        exposed: s.exposed && s.port !== undefined,
        port: s.exposed ? s.port : undefined,
        domain: s.domain,
        cpuCores: s.cpuCores,
        memoryMb: s.memoryMb,
        env: s.env as unknown as DetectedService["env"],
      }));
      // 共享资源复用：reuse 里的中间件不部署，只注入共享变量
      const reused = new Set(body.reuse);
      if (reused.size > 0 && reused.size === services.length) {
        return status(422, { error: "所有服务都选择了复用共享资源——至少保留一个业务服务需要部署" });
      }
      const upServices = reused.size > 0
        ? services.map((s) => s.name).filter((n) => !reused.has(n))
        : undefined;
      const target = await svc.createAppTarget({
        nodeId: body.nodeId,
        name: body.name,
        repoUrl: body.repoUrl?.trim() || undefined,
        branch: body.branch,
        composePath: body.composePath,
        remoteDir: body.remoteDir,
        envText: body.envText,
        overrideCompose: detectToOverrideCompose({ services }),
        dependsOn: body.depIds,
        domains: services
          .filter((s) => s.domain && s.port)
          .map((s) => ({ hostname: s.domain!, targetPort: s.port!, serviceName: s.name })),
        services,
        upServices,
      });
      // Railway 式：创建即部署，client 直接换日志面板盯进度
      void svc.deploy(target.id);
      return { targetId: target.id };
    },
  )
  .post(
    "/targets/db",
    {
      body: t.Object({
        nodeId: t.Number(),
        name: t.String({ minLength: 1 }),
        dbType: t.Union([t.Literal("postgres"), t.Literal("mysql"), t.Literal("redis"), t.Literal("mongo")]),
        instanceId: t.Optional(t.String()),
        remoteDir: t.Optional(t.String()),
      }),
    },
    async ({ di, body }) => {
      const svc = ctxOf(di).deploy;
      const instanceId = body.instanceId ? Number(body.instanceId) : 0;
      const target = instanceId
        ? await svc.createLogicalDbTarget({ nodeId: body.nodeId, name: body.name, instanceId })
        : await svc.createDbTarget({
          nodeId: body.nodeId,
          name: body.name,
          dbType: body.dbType,
          remoteDir: body.remoteDir ?? "",
        });
      void svc.deploy(target.id); // 创建即部署
      return { ok: true as const };
    },
  )
  .post("/targets/:id/deploy", { params: t.Object({ id: t.Number() }) }, ({ di, params, set }) => {
    void ctxOf(di).deploy.deploy(params.id); // 后台跑，状态迁移走 SSE 推到画布
    set.status = 204;
  })
  // 区域硬隔离的显式通道：本地构建产物推到远端（不起容器），成功置 artifactShipped
  .post("/targets/:id/ship", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    await ctxOf(di).deploy.shipArtifact(params.id); // 校验同步抛；构建走后台+SSE
    set.status = 204;
  })
  // 卡迁移到另一台服务器：跨界（local↔remote）要 artifactShipped 门票（service 内校验）
  .patch(
    "/targets/:id/move",
    { params: t.Object({ id: t.Number() }), body: t.Object({ nodeId: t.Number() }) },
    async ({ di, params, body, set }) => {
      await ctxOf(di).deploy.moveTargetToNode(params.id, body.nodeId);
      set.status = 204;
    },
  )
  // 部署策略三态（manual/notify/auto）：轮询器按此列决定动作
  .post(
    "/targets/:id/policy",
    { params: t.Object({ id: t.Number() }), body: t.Object({ policy: t.Union([t.Literal("manual"), t.Literal("notify"), t.Literal("auto")]) }) },
    async ({ di, params, body, set }) => {
      await ctxOf(di).deploy.setDeployPolicy(params.id, body.policy);
      set.status = 204;
    },
  )
  // 回滚到某次成功部署：快照校验同步抛（无快照→ServiceError 映射），执行走后台+SSE
  .post(
    "/targets/:id/rollback",
    { params: t.Object({ id: t.Number() }), body: t.Object({ runId: t.Number() }) },
    async ({ di, params, body, set }) => {
      await ctxOf(di).deploy.rollback(params.id, body.runId);
      set.status = 204;
    },
  )
  .get(
    "/targets/:id/log",
    { params: t.Object({ id: t.Number() }), query: t.Object({ dep: t.Optional(t.Numeric()) }) },
    async ({ di, params, query, set }) => {
      const svc = ctxOf(di).deploy;
      const target = await svc.targetById(params.id);
      if (!target) {
        return status(404, { error: "部署目标不存在" });
      }
      const dep = query.dep ? await svc.deploymentById(query.dep) : await svc.latestDeployment(target.id);
      return { target, dep };
    },
  )
  .get(
    "/targets/:id/log-body",
    { params: t.Object({ id: t.Number() }), query: t.Object({ dep: t.Optional(t.Numeric()) }) },
    async ({ di, params, query }) => {
      const svc = ctxOf(di).deploy;
      const dep = query.dep ? await svc.deploymentById(query.dep) : await svc.latestDeployment(params.id);
      return dep ? await svc.logTextOf(dep.id) : "";
    },
  )
  // ── 服务抽屉（Railway Service View）数据：各 Tab 按需取数 ──
  .get(
    "/targets/:id/service",
    {
      params: t.Object({ id: t.Number() }),
      query: t.Object({ svc: t.Optional(t.String()), tab: t.Optional(t.String()) }),
    },
    async ({ di, params, query, set }) => {
      const ctx = ctxOf(di);
      const target = await ctx.deploy.targetById(params.id);
      if (!target) {
        return status(404, { error: "部署目标不存在" });
      }
      const tab = (TABS.includes(query.tab as (typeof TABS)[number]) ? query.tab : "deployments") as (typeof TABS)[number];
      return {
        target,
        svc: query.svc || undefined,
        tab,
        deployments: tab === "deployments" ? await ctx.deploy.deploymentsOfTarget(params.id) : undefined,
        envText: tab === "env" && query.svc ? await ctx.runtime.serviceEnvText(params.id, query.svc) : undefined,
        dbRefs: tab === "env" && query.svc ? await ctx.deploy.dbRefsOfNode(target.nodeId) : undefined,
        sharedEnv: tab === "env" ? await ctx.deploy.sharedEnvOfTarget(params.id) : undefined,
        selectedDeps: tab === "env" && query.svc
          ? ctx.deploy.edgesOfTarget(target).filter((e) => e.service === query.svc).map((e) => e.db)
          : undefined,
        domains: tab === "network" ? await ctx.edge.domainsOfTarget(params.id) : undefined,
        resources: tab === "hardware" && query.svc ? await ctx.runtime.serviceResources(params.id, query.svc) : undefined,
        backups: tab === "backups" ? await ctx.backup.backupsOf(params.id) : undefined,
        metrics: tab === "monitor" ? await ctx.runtime.serviceStats(params.id, query.svc || undefined) : undefined,
      };
    },
  )
  .get(
    "/targets/:id/service/metrics",
    { params: t.Object({ id: t.Number() }), query: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params, query }) => ctxOf(di).runtime.serviceStats(params.id, query.svc),
  )
  .post(
    "/targets/:id/service/restart",
    { params: t.Object({ id: t.Number() }), body: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params, body }) => {
      await ctxOf(di).runtime.restartService(params.id, body.svc || undefined);
      // 结构不变（容器状态走 SSE），不刷新画布
      return { notice: "已发送重启" };
    },
  )
  .get(
    "/targets/:id/service/logs",
    { params: t.Object({ id: t.Number() }), query: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params, query }) => ctxOf(di).runtime.serviceLogs(params.id, query.svc),
  )
  .post(
    "/targets/:id/service/env",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ svc: t.String({ minLength: 1 }), envText: t.Optional(t.String()), depIds: t.Array(t.Number()) }),
    },
    async ({ di, params, body }) => {
      const ctx = ctxOf(di);
      await ctx.runtime.setServiceEnv(params.id, body.svc, body.envText ?? "");
      // 依赖勾选同步服务级连线：整组替换该服务的边，app 级/其他服务的边不动
      const target = await ctx.deploy.targetById(params.id);
      if (target) {
        const kept = ctx.deploy.edgesOfTarget(target).filter((e) => e.service !== body.svc);
        const added = body.depIds.map((db) => ({ service: body.svc, db }));
        await ctx.deploy.setDependsOn(params.id, [...kept, ...added]);
      }
      return { notice: "已保存，重新部署后生效" };
    },
  )
  .post(
    "/targets/:id/service/resources",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ svc: t.String({ minLength: 1 }), cpuCores: t.Optional(t.Number()), memoryMb: t.Optional(t.Number()) }),
    },
    async ({ di, params, body }) => {
      await ctxOf(di).runtime.setServiceResources(params.id, body.svc, body.cpuCores, body.memoryMb);
      // 资源限制只写 override compose，画布结构不变
      return { notice: "已保存，重新部署后生效" };
    },
  )
  .post(
    "/targets/:id/service/domains",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ svc: t.Optional(t.String()), hostname: t.String({ minLength: 1 }), targetPort: t.Number() }),
    },
    async ({ di, params, body }) => {
      const ctx = ctxOf(di);
      await ctx.edge.addDomain(params.id, { hostname: body.hostname, targetPort: body.targetPort, serviceName: body.svc || undefined });
      await ctx.deploy.syncEdge(params.id);
      return { notice: "已绑定" };
    },
  )
  .delete(
    "/targets/:id/service/domains/:domainId",
    { params: t.Object({ id: t.Number(), domainId: t.Number() }), query: t.Object({ svc: t.Optional(t.String()) }) },
    async ({ di, params }) => {
      await ctxOf(di).edge.removeDomain(params.domainId);
      return { notice: "已解绑" };
    },
  )
  // Source Tab：来源配置（GitHub 仓库/分支/compose 路径；本地导入显示本地路径）
  .post(
    "/targets/:id/source",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({
        repoUrl: t.Optional(t.String()),
        branch: t.Optional(t.String()),
        composePath: t.Optional(t.String()),
        remoteDir: t.Optional(t.String()),
      }),
    },
    async ({ di, params, body }) => {
      await ctxOf(di).deploy.updateSource(params.id, body);
      return { notice: "已保存，下次部署生效" };
    },
  )
  // Console Tab：容器交互式终端（xterm ←→ WS ←→ docker exec TTY）
  .ws("/console/:id", {
    params: t.Object({ id: t.Number() }),
    query: t.Object({ svc: t.Optional(t.String()) }),
    async open(ws) {
      // Elysia 2.0：ws handler 收到的是上下文与 socket 方法的合并对象（无 .data 层）
      const ctx = ws as unknown as {
        di: { get(name: string): any };
        params: { id: string };
        query: { svc?: string };
        send(d: string): unknown;
        close(): unknown;
      };
      try {
        const session = await (ctx.di.get("runtimeService") as RuntimeService).openConsole(Number(ctx.params.id), ctx.query.svc || undefined);
        consoleSessions.set(ws, session);
        session.stream.on("data", (chunk: Buffer) => ctx.send(chunk.toString("utf8")));
        session.stream.on("end", () => ctx.close());
        session.stream.on("error", () => ctx.close());
      } catch (e) {
        ctx.send(`\r\n\x1b[31m连接失败：${(e as Error).message}\x1b[0m\r\n`);
        ctx.close();
      }
    },
    message(ws, raw) {
      const session = consoleSessions.get(ws);
      if (!session) return;
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : String(raw)) as
          | { type: "input"; data: string }
          | { type: "resize"; cols: number; rows: number };
        if (msg.type === "input") session.stream.write(msg.data);
        else if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0)
          session.exec.resize({ h: msg.rows, w: msg.cols }).catch(() => {});
      } catch { /* 坏帧忽略 */ }
    },
    close(ws) {
      const session = consoleSessions.get(ws);
      consoleSessions.delete(ws);
      session?.stream.end();
    },
  })
  .post("/targets/:id/backup", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const file = await ctxOf(di).backup.backupNow(params.id);
    return { notice: `已备份：${file}` };
  })
  .get(
    "/backups/:id/:file",
    { params: t.Object({ id: t.Number(), file: t.String() }) },
    async ({ di, params, set }) => {
      const path = ctxOf(di).backup.backupFilePath(params.id, params.file);
      if (!path) return status(404, "备份不存在");
      set.headers["content-disposition"] = `attachment; filename="${params.file}"`;
      set.headers["content-type"] = "application/gzip";
      return Bun.file(path);
    },
  )
  // ── 变量抽屉数据：已有 app 改 .env + 数据库依赖 ──
  .get("/targets/:id/env", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    const svc = ctxOf(di).deploy;
    const target = await svc.targetById(params.id);
    if (!target || target.kind !== "app") {
      return status(404, { error: "部署目标不存在" });
    }
    return {
      target,
      envText: svc.envTextOf(target),
      dbRefs: await svc.dbRefsOfNode(target.nodeId),
      selectedDeps: target.dependsOn ?? [],
    };
  })
  .post(
    "/targets/:id/env",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ envText: t.Optional(t.String()), depIds: t.Array(t.Number()) }),
    },
    async ({ di, params, body, set }) => {
      const svc = ctxOf(di).deploy;
      const target = await svc.targetById(params.id);
      if (!target || target.kind !== "app") {
        return status(404, { error: "部署目标不存在" });
      }
      await svc.updateAppEnv(params.id, body.envText ?? "", body.depIds);
      return { ok: true as const };
    },
  )
  // ── 画布拖线建/删依赖：整组覆盖服务级边 ──
  .put(
    "/targets/:id/deps",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({
        edges: t.Array(t.Object({ service: t.Union([t.String(), t.Null()]), db: t.Number() })),
      }),
    },
    async ({ di, params, body, set }) => {
      await ctxOf(di).deploy.setDependsOn(params.id, body.edges);
      set.status = 204;
    },
  )
  // ── 画布布局：app/db 卡位置 + 服务卡位置 ──
  .patch(
    "/targets/:id/layout",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        w: t.Optional(t.Number()),
        h: t.Optional(t.Number()),
        groupId: t.Optional(t.Union([t.Number(), t.Null()])),
        serviceLayout: t.Optional(t.Record(t.String(), t.Object({ x: t.Number(), y: t.Number() }))),
      }),
    },
    async ({ di, params, body, set }) => {
      await ctxOf(di).deploy.setLayout(params.id, body);
      set.status = 204;
    },
  )
  // ── 域名绑定 ──
  .get("/targets/:id/domains", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    const ctx = ctxOf(di);
    const target = await ctx.deploy.targetById(params.id);
    if (!target) {
      return status(404, { error: "部署目标不存在" });
    }
    return { target, domains: await ctx.edge.domainsOfTarget(target.id) };
  })
  .post(
    "/targets/:id/domains",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ hostname: t.String({ minLength: 1 }), targetPort: t.Number() }),
    },
    async ({ di, params, body, set }) => {
      const ctx = ctxOf(di);
      const target = await ctx.deploy.targetById(params.id);
      if (!target) {
        return status(404, { error: "部署目标不存在" });
      }
      await ctx.edge.addDomain(params.id, body);
      await ctx.deploy.syncEdge(params.id); // 立即对账（DNS/证书状态回写），失败由 ServiceError 映射
      return { ok: true as const };
    },
  )
  .delete("/domains/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    const ctx = ctxOf(di);
    const domain = await ctx.edge.domainById(params.id);
    if (!domain) {
      return status(404, { error: "域名不存在" });
    }
    await ctx.edge.removeDomain(params.id);
    await ctx.deploy.syncEdge(domain.targetId);
    return { ok: true as const };
  })
  .delete("/targets/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    // 例如「实例下还有逻辑库」时 removeTarget 抛 ServiceError（409 语义由 ServiceError 子类化再细化）
    await ctxOf(di).deploy.removeTarget(params.id);
    set.status = 204;
  });
