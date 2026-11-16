import { status, t } from "elysia";
import { ServiceError } from "@elysiax/core";
import { defineRoutes, type ServiceMap } from "../../../.elysiax";
import type { ServerService } from "./servers.service";
import type { ResourceService } from "../resources/resources.socket";
import type { ResourcesResponse, ServersModel } from "./servers.types";

/** DI 容器视图：键与返回类型全部来自 codegen 的 ServiceMap，不重抄 */
type Di = { get<K extends keyof ServiceMap>(k: K): ServiceMap[K] };

const serverForm = t.Object({
  name: t.String({ minLength: 1 }),
  host: t.String({ minLength: 1 }),
  port: t.Numeric({ default: 22 }),
  user: t.String({ minLength: 1 }),
  authType: t.Union([
    t.Literal("key"),
    t.Literal("password"),
    t.Literal("agent"),
  ]),
  keyPath: t.Optional(t.String()),
  password: t.Optional(t.String()),
  registryMirrors: t.Optional(t.String()),
});

const DB_TYPES = [
  t.Literal("postgres"),
  t.Literal("mysql"),
  t.Literal("redis"),
  t.Literal("mongo"),
] as const;

/** 共享资源弹窗数据：服务器 + 每个资源的连接串（未部署为 null） */
async function resourcesModel(
  svc: ResourceService,
  servers: ServerService,
  serverId: number,
): Promise<ResourcesResponse> {
  const server = await servers.byId(serverId);
  if (!server) throw new ServiceError(`服务器不存在: ${serverId}`);
  const resources = await svc.ofServer(serverId);
  const withUrl = await Promise.all(
    resources.map(async (r) => ({ resource: r, url: await svc.urlOf(r.id) })),
  );
  return { server, resources: withUrl };
}

const listModel = async (di: Di): Promise<ServersModel> => ({
  servers: await di.get("serverService").list(),
});

/** servers 的 JSON API（Solid 页；壳由 codegen HTMLBundle 服务）。 */
export default defineRoutes()
  .get("/", async ({ di }): Promise<ServersModel> => listModel(di))
  .post("/", { body: serverForm }, async ({ di, body }) => {
    await di.get("serverService").create({
      ...body,
      keyPath: body.keyPath || undefined,
      password: body.password || undefined,
      registryMirrors: body.registryMirrors || undefined,
    });
    return listModel(di);
  })
  .delete(
    "/:id",
    { params: t.Object({ id: t.Number() }) },
    async ({ di, params }) => {
      await di.get("serverService").remove(params.id);
      return listModel(di);
    },
  )
  // ── 检测 / TOFU 信任 / 安装 docker / 镜像源 ──
  .post(
    "/:id/check",
    { params: t.Object({ id: t.Number() }) },
    async ({ di, params }) => {
      const svc = di.get("serverService");
      const result = await svc.check(params.id);
      const server = await svc.byId(params.id);
      if (!server) return status(404, { error: "服务器不存在" });
      return { server, result };
    },
  )
  .post(
    "/:id/trust",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ fingerprint: t.String() }),
    },
    async ({ di, params, body }) => {
      const svc = di.get("serverService");
      const result = await svc.trust(params.id, body.fingerprint);
      const server = await svc.byId(params.id);
      if (!server) return status(404, { error: "服务器不存在" });
      return { server, result };
    },
  )
  .post(
    "/:id/install-docker",
    { params: t.Object({ id: t.Number() }) },
    async ({ di, params }) => {
      const svc = di.get("serverService");
      const { code, output } = await svc.installDocker(params.id);
      const server = await svc.byId(params.id);
      if (!server) return status(404, { error: "服务器不存在" });
      return { server, code, output };
    },
  )
  .post(
    "/:id/registry-mirrors",
    {
      params: t.Object({ id: t.Number() }),
      body: t.Object({ mirrors: t.Optional(t.String()) }),
    },
    async ({ di, params, body }) => {
      const svc = di.get("serverService");
      const result = await svc.configureMirrors(params.id, body.mirrors ?? "");
      const server = await svc.byId(params.id);
      if (!server) return status(404, { error: "服务器不存在" });
      return { server, result };
    },
  )
  // ── 共享资源（弹窗内写操作，client 每次返回整段刷新） ──
  .get(
    "/resources/:id",
    { params: t.Object({ id: t.Number() }) },
    async ({ di, params }): Promise<ResourcesResponse> =>
      resourcesModel(
        di.get("resourceService"),
        di.get("serverService"),
        params.id,
      ),
  )
  .post(
    "/resources",
    {
      body: t.Object({
        serverId: t.Numeric(),
        name: t.String({ minLength: 1 }),
        dbType: t.Union([...DB_TYPES]),
        envKey: t.Optional(t.String()),
      }),
    },
    async ({ di, body }): Promise<ResourcesResponse> => {
      // 预期错误（重名/非法 envKey 等）由 resourceService 抛 ServiceError，框架统一回显
      const svc = di.get("resourceService");
      await svc.create({
        serverId: body.serverId,
        name: body.name.trim(),
        dbType: body.dbType,
        envKey: body.envKey,
      });
      return resourcesModel(
        svc,
        di.get("serverService"),
        body.serverId,
      );
    },
  )
  .post(
    "/resources/:id/deploy",
    { params: t.Object({ id: t.Number() }) },
    async ({ di, params }) => {
      const svc = di.get("resourceService");
      const target = await svc.byId(params.id);
      if (!target) return status(404, { error: "共享资源不存在" });
      await svc.deploy(params.id);
      return resourcesModel(
        svc,
        di.get("serverService"),
        target.serverId,
      );
    },
  )
  .delete(
    "/resources/:id",
    { params: t.Object({ id: t.Number() }) },
    async ({ di, params }) => {
      const svc = di.get("resourceService");
      const target = await svc.byId(params.id);
      if (!target) return status(404, { error: "共享资源不存在" });
      await svc.remove(params.id);
      return resourcesModel(
        svc,
        di.get("serverService"),
        target.serverId,
      );
    },
  );
