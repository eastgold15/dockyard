import { defineRoutes } from "../../../.elysiax";
import { t } from "elysia";
import { ResourceListBody, ServerList, ServerRow, TrustPrompt, resourcesModel } from "./servers.partials";

const serverForm = t.Object({
  name: t.String({ minLength: 1 }),
  host: t.String({ minLength: 1 }),
  port: t.Numeric({ default: 22 }),
  user: t.String({ minLength: 1 }),
  authType: t.Union([t.Literal("key"), t.Literal("password"), t.Literal("agent")]),
  keyPath: t.Optional(t.String()),
  password: t.Optional(t.String()),
});

const DB_TYPES = [t.Literal("postgres"), t.Literal("mysql"), t.Literal("redis"), t.Literal("mongo")] as const;

export default defineRoutes()
  .post("/", { body: serverForm }, async ({ di, body, toast }) => {
    await di.get("serverService").create({
      ...body,
      keyPath: body.keyPath || undefined,
      password: body.password || undefined,
    });
    toast(`服务器「${body.name}」已添加`);
    return <ServerList servers={await di.get("serverService").list()} />;
  })
  .delete("/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params, toast }) => {
    await di.get("serverService").remove(params.id);
    toast("服务器已删除");
    return <ServerList servers={await di.get("serverService").list()} />;
  })
  .post("/:id/check", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("serverService");
    const id = params.id;
    const result = await svc.check(id);
    const server = (await svc.byId(id))!;
    if (result.ok) return <ServerRow server={server} message={`连接成功，docker ${result.dockerVersion}${result.warning ? `\n⚠️ ${result.warning}` : ""}`} />;
    if (result.reason === "need-trust")
      return <TrustPrompt server={server} fingerprint={result.fingerprint} algorithm={result.algorithm} />;
    return <ServerRow server={server} message={result.message} />;
  })
  .post(
    "/:id/trust",
    { params: t.Object({ id: t.Number() }), body: t.Object({ fingerprint: t.String() }) },
    async ({ di, params, body }) => {
      const svc = di.get("serverService");
      const id = params.id;
      const result = await svc.trust(id, body.fingerprint);
      const server = (await svc.byId(id))!;
      if (result.ok) return <ServerRow server={server} message={`已信任主机，docker ${result.dockerVersion}${result.warning ? `\n⚠️ ${result.warning}` : ""}`} />;
      return <ServerRow server={server} message={"message" in result ? result.message : "信任后检测失败"} />;
    },
  )
  .post("/:id/install-docker", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("serverService");
    const id = params.id;
    const { code, output } = await svc.installDocker(id);
    const server = (await svc.byId(id))!;
    return (
      <ServerRow
        server={server}
        message={code === 0 ? `docker 安装完成\n${output.slice(-500)}` : `安装失败（exit ${code}）\n${output.slice(-1000)}`}
      />
    );
  })
  // ── 共享资源（弹窗内写操作，刷新 #shared-resources-body） ──
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
    async ({ di, body }) => {
      // 预期错误（重名/非法 envKey 等）由 resourceService 抛 ServiceError，框架统一回显
      const svc = di.get("resourceService");
      await svc.create({ serverId: body.serverId, name: body.name.trim(), dbType: body.dbType, envKey: body.envKey });
      const { server, resources } = await resourcesModel(svc, di.get("serverService"), body.serverId);
      return <ResourceListBody server={server} resources={resources} />;
    },
  )
  .post("/resources/:id/deploy", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("resourceService");
    const target = await svc.byId(params.id);
    if (!target) return "";
    await svc.deploy(params.id);
    const { server, resources } = await resourcesModel(svc, di.get("serverService"), target.serverId);
    return <ResourceListBody server={server} resources={resources} />;
  })
  .delete("/resources/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const svc = di.get("resourceService");
    const target = await svc.byId(params.id);
    if (!target) return "";
    await svc.remove(params.id);
    const { server, resources } = await resourcesModel(svc, di.get("serverService"), target.serverId);
    return <ResourceListBody server={server} resources={resources} />;
  });
