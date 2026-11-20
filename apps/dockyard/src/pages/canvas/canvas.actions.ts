import { status, t } from "elysia";
import { defineRoutes, type CanvasServices } from "../../../.elysiax";
import { CANVAS_CHANNEL, events } from "@/pages/deploy/deploy.socket";
import type { BoardModel } from "./canvas.model";

/**
 * canvas 页面的 JSON API。
 *
 * 窄类型 CanvasServices = 本原子 provides ∪ 它们的直接依赖，所以
 * canvasService（纯结构操作）与 boardService（跨原子组合）都在视野内。
 * 跨原子取服务一律经 boardService，不在这里 di.get 别的原子的服务。
 */
export default defineRoutes<CanvasServices>()
  // ── client 壳的项目解析 ──
  .get("/projects", async ({ di }) => di.get("boardService").projects())
  // 缺省项目：最近一个（无 → 404，client 显示「先建项目」）
  .get("/latest", async ({ di }) => {
    const projectId = await di.get("boardService").latestProjectId();
    if (projectId === undefined) return status(404, { error: "还没有项目" });
    return { projectId };
  })
  // 本地项目行点击：按路径幂等落库
  .get(
    "/resolve-local",
    { query: t.Object({ path: t.String({ minLength: 1 }) }) },
    async ({ di, query }) => ({
      projectId: await di.get("boardService").resolveLocal(query.path),
    }),
  )
  // 画布数据：结构 + 布局（无实时；视图模型见 canvas.model.ts）。
  // 世界地图：返回全部服务器卡。client 只在挂载和 refresh（结构变更）时拉取，不轮询
  .get("/board", async ({ di }): Promise<BoardModel> => di.get("boardService").board())
  // 实时状态 SSE（全局频道）：部署 status/running（deploy.service 推）+ 容器 state（container-poller 推）。
  // 首帧发部署状态 + 容器状态全量快照（订阅即齐，不等下轮 diff）。
  // 快照是 async，等它跑完时 di 已被释放（Container is disposed）→ 由 boardService 持有引用后调用
  .get("/events", ({ di }) => {
    const board = di.get("boardService");
    return events.stream(CANVAS_CHANNEL, () => board.snapshot());
  })
  // 服务器卡上画：幂等——同 serverId 已存在则返回已有卡，不新建。
  // 落点钳进该服务器的车道（右键在对面车道建卡时直接归位，不报错——建卡无恶意场景）
  .post(
    "/nodes",
    { body: t.Object({ serverId: t.Number(), x: t.Number(), y: t.Number() }) },
    async ({ di, body }) =>
      di.get("boardService").addNode(body.serverId, body.x, body.y),
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
      const result = await di.get("boardService").moveNode(params.id, body);
      if (!result.ok) return status(422, { error: result.error });
      set.status = 204;
    },
  )
  .delete(
    "/nodes/:id",
    { params: t.Object({ id: t.Number() }) },
    async ({ di, params, set }) => {
      await di.get("canvasService").removeNode(params.id);
      set.status = 204;
    },
  )
  // ── 服务分组：服务器卡内的命名容器（Railway Service Group）──
  .post(
    "/nodes/:id/groups",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ name: t.String({ minLength: 1 }) }),
    },
    async ({ di, params, body, set }) => {
      await di.get("canvasService").addGroup(params.id, body.name);
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
      await di.get("canvasService").updateGroup(params.id, body);
      set.status = 204;
    },
  )
  // 删除分组：组内目标回落到服务器卡（deploy 上下文清 groupId）
  .delete(
    "/groups/:id",
    { params: t.Object({ id: t.Number() }) },
    async ({ di, params, set }) => {
      await di.get("boardService").removeGroup(params.id);
      set.status = 204;
    },
  );
