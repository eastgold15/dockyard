import { status, t } from "elysia";
import { defineRoutes } from "../../../.elysiax";
import { CANVAS_CHANNEL, events, type DeployService, type DeployTarget } from "../deploy/deploy.socket";
import type { ProjectService } from "../projects/projects.socket";
import type { ServerService } from "../servers/servers.socket";
import type { EdgeService } from "../edge/edge.socket";
import type { BoardModel, CardModel } from "./canvas.model";
import type { CanvasService } from "./canvas.service";
import { isLocalHost } from "./canvas.socket";
import { clampCardX, violatesLane } from "./zones";

interface Ctx {
  project: ProjectService;
  server: ServerService;
  canvas: CanvasService;
  deploy: DeployService;
  edge: EdgeService;
}

/** 跨上下文组合：canvas 只存节点，服务器/部署信息在此拼装；
 *  部署侧的视图整形（连接串解密、compose 清单、依赖边）在 DeployService。
 *  世界地图：无项目边界，返回全部服务器卡；target 的项目归属（projectId/projectName）逐个补齐 */
async function canvasData(ctx: Ctx) {
  const [nodes, servers, projects] = await Promise.all([
    ctx.canvas.nodesAll(),
    ctx.server.list(),
    ctx.project.list(), // 一次 list 建 Map，避免按 target 逐个查（N+1）
  ]);
  const byId = new Map(servers.map((s) => [s.id, s]));
  const projectNameOf = new Map(projects.map((p) => [p.id, p.name]));
  const cards: CardModel[] = [];
  const rawTargets = new Map<number, DeployTarget>(); // 依赖边派生用（edgesOfTarget 要原始行）
  for (const node of nodes) {
    const server = byId.get(node.serverId);
    if (!server) continue;
    const targets = [];
    for (const target of await ctx.deploy.targetsOfNode(node.id)) {
      rawTargets.set(target.id, target);
      // app 的域名绑定（edge 反代 + 证书状态徽章）；serviceName 用于下沉到 compose 服务行
      const domains = target.kind === "app"
        ? (await ctx.edge.domainsOfTarget(target.id)).map((d) => ({
          hostname: d.hostname,
          sslStatus: d.sslStatus,
          dnsStatus: d.dnsStatus,
          serviceName: d.serviceName,
          targetPort: d.targetPort,
        }))
        : [];
      // compose 服务清单（创建落库/存量惰性补全）；容器状态在下方按服务器聚合后填入
      const svcDoc = target.kind === "app"
        ? await ctx.deploy.servicesOfTarget(target)
        : { project: null, services: [] };
      targets.push({
        id: target.id,
        kind: target.kind,
        name: target.name,
        projectId: target.projectId ?? 0, // 0 = 未关联项目
        projectName: (target.projectId && projectNameOf.get(target.projectId)) || "",
        logical: Boolean(target.instanceOf),
        url: ctx.deploy.logicalUrlOf(target), // 逻辑库连接串（复制按钮）
        // 归属到具体服务的域名下沉到服务行；无归属的留 target 顶部
        domains: domains.filter((d) => !d.serviceName || !svcDoc.services.some((s) => s.name === d.serviceName)),
        services: svcDoc.services.map((s) => ({
          ...s,
          domains: domains.filter((d) => d.serviceName === s.name),
          ...(target.serviceLayout?.[s.name] ?? {}),
        })),
        edges: [], // 下方知道全部 target 名字后回填
        groupId: target.groupId,
        x: target.x,
        y: target.y,
        w: target.w,
        h: target.h,
        updateAvailable: target.updateAvailable,
        artifactShipped: target.artifactShipped,
      });
    }
    const { id, name, user, host, port, dockerStatus, dockerVersion } = server;
    const groups = (await ctx.canvas.groupsOf(node.id)).map((g) => ({
      id: g.id, name: g.name, x: g.x, y: g.y, w: g.w, h: g.h,
    }));
    cards.push({
      node: { id: node.id, x: node.x, y: node.y, w: node.w, h: node.h },
      server: { id, name, user, host, port, dockerStatus, dockerVersion, local: isLocalHost(host) },
      targets,
      groups,
    });
  }
  // 服务级依赖边（client 派生 React Flow 边）；存量 dependsOn 由门面惰性派生为 service=null 的边
  const nameOfTarget = new Map<number, string>();
  for (const c of cards)
    for (const t of c.targets) nameOfTarget.set(t.id, t.name);
  for (const c of cards)
    for (const t of c.targets) {
      const raw = rawTargets.get(t.id);
      if (!raw) continue;
      t.edges = ctx.deploy.edgesOfTarget(raw).map((e) => ({
        service: e.service,
        db: e.db,
        dbName: nameOfTarget.get(e.db) ?? `#${e.db}`,
      }));
    }
  return {
    servers: servers.map(({ id, name }) => ({ id, name })),
    cards,
  };
}

const ctxOf = (di: {
  get(k: "projectService"): ProjectService;
  get(k: "serverService"): ServerService;
  get(k: "canvasService"): CanvasService;
  get(k: "deployService"): DeployService;
  get(k: "edgeService"): EdgeService;
}): Ctx => ({
  project: di.get("projectService"),
  server: di.get("serverService"),
  canvas: di.get("canvasService"),
  deploy: di.get("deployService"),
  edge: di.get("edgeService"),
});

export default defineRoutes()
  // ── client 壳的项目解析 ──
  .get("/projects", async ({ di }) =>
    (await di.get("projectService").list()).map((p) => ({ id: p.id, name: p.name })))
  // 缺省项目：最近一个（无 → 404，client 显示「先建项目」）
  .get("/latest", async ({ di, set }) => {
    const latest = (await di.get("projectService").list()).at(-1);
    if (!latest) {
      return status(404, { error: "还没有项目" });
    }
    return { projectId: latest.id };
  })
  // 本地项目行点击：按路径幂等落库
  .get("/resolve-local", { query: t.Object({ path: t.String({ minLength: 1 }) }) }, async ({ di, query }) => ({
    projectId: (await di.get("projectService").ensureLocal(query.path)).id,
  }))
  // 画布数据：结构 + 布局（无实时；视图模型见 canvas.model.ts）。
  // 世界地图：返回全部服务器卡。client 只在挂载和 refresh（结构变更）时拉取，不轮询
  .get("/board", async ({ di }): Promise<BoardModel> => {
    return canvasData(ctxOf(di));
  })
  // 实时状态 SSE（全局频道）：部署 status/running（deploy.service 推）+ 容器 state（container-poller 推）。
  // 首帧发容器状态全量快照（订阅即齐，不等下轮 diff）
  .get("/events", ({ di }) =>
    events.stream(CANVAS_CHANNEL, () => di.get("containerPoller").statesAll()))
  // 服务器卡上画：幂等——同 serverId 已存在则返回已有卡，不新建。
  // 落点钳进该服务器的车道（右键在对面车道建卡时直接归位，不报错——建卡无恶意场景）
  .post(
    "/nodes",
    { body: t.Object({ serverId: t.Number(), x: t.Number(), y: t.Number() }) },
    async ({ di, body }) => {
      const ctx = ctxOf(di);
      const server = await ctx.server.byId(body.serverId);
      const x = server ? clampCardX(isLocalHost(server.host), body.x, 320) : body.x;
      return ctx.canvas.addNode(body.serverId, x, body.y);
    },
  )
  // 拖拽/resize 持久化。区域硬隔离：车道规则（zones.ts 单一事实源）——
  // 卡片完整矩形不许压中立带，服务端按生效后的矩形裁决（client 钳制只是体验层）。
  .patch(
    "/nodes/:id",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        w: t.Optional(t.Number()),
        h: t.Optional(t.Number()),
      }),
    },
    async ({ di, params, body, set }) => {
      const ctx = ctxOf(di);
      if (body.x !== undefined || body.w !== undefined) {
        const node = await ctx.canvas.byId(params.id);
        const server = node ? await ctx.server.byId(node.serverId) : undefined;
        if (node && server) {
          const local = isLocalHost(server.host);
          const x = body.x ?? node.x, w = body.w ?? node.w;
          if (violatesLane(local, x, w)) {
            return status(422, { error: local ? "本机服务器不能压到中立带（远程区一侧）" : "远程服务器不能压到中立带（本机区一侧）" });
          }
        }
      }
      await ctx.canvas.moveNode(params.id, body);
      set.status = 204;
    },
  )
  .delete("/nodes/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    await ctxOf(di).canvas.removeNode(params.id);
    set.status = 204;
  })
  // ── 服务分组：服务器卡内的命名容器（Railway Service Group）──
  .post(
    "/nodes/:id/groups",
    { params: t.Object({ id: t.Number() }), body: t.Object({ name: t.String({ minLength: 1 }) }) },
    async ({ di, params, body, set }) => {
      await ctxOf(di).canvas.addGroup(params.id, body.name);
      set.status = 204;
    },
  )
  .patch(
    "/groups/:id",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({
        name: t.Optional(t.String()),
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        w: t.Optional(t.Number()),
        h: t.Optional(t.Number()),
      }),
    },
    async ({ di, params, body, set }) => {
      await ctxOf(di).canvas.updateGroup(params.id, body);
      set.status = 204;
    },
  )
  // 删除分组：组内目标回落到服务器卡（deploy 上下文清 groupId）
  .delete("/groups/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, set }) => {
    await di.get("deployService").clearGroup(params.id);
    await ctxOf(di).canvas.removeGroup(params.id);
    set.status = 204;
  });
