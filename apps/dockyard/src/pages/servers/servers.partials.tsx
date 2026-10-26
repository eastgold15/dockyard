import { defineRoutes } from "../../../.elysiax";
import { routes } from "../../../.elysiax";
import { t } from "elysia";
import type { Component } from "@elysiax/htmx";
import type { Server } from "./schema";
import type { ServerResource } from "../resources/resources.socket";
import type { ServerService } from "./servers.service";
import type { ResourceService } from "../resources/resources.socket";
import { Badge, Button, Empty, Field, Modal, PageHeader } from "../../shared/ui";
import { isLocalHost } from "./servers.socket";

/** 本机/远程徽章（部署通道分界线：本机=回环地址，画布上两区硬隔离） */
const scopeBadge = (s: Server) =>
  isLocalHost(s.host) ? <Badge label="本机" tone="ok" /> : <Badge label="远程" tone="muted" />;

const dockerBadge = (s: Server) => {
  if (s.dockerStatus === "ok") return <Badge label={`docker ${s.dockerVersion ?? "ok"}`} tone="ok" />;
  if (s.dockerStatus === "missing") return <Badge label="无 docker" tone="err" />;
  return <Badge label="未检测" tone="muted" />;
};

export const ServerRow: Component<{ server: Server; message?: string }> = ({ server, message }) => (
  <div class="border-b border-harbor-800/60" id={`server-${server.id}`}>
    <div class="flex h-12 items-center gap-4 px-6 hover:bg-harbor-900">
      <span class="text-sm font-medium text-neutral-100">{server.name}</span>
      {scopeBadge(server)}
      <span class="mono text-xs text-neutral-500">{server.user}@{server.host}:{server.port}</span>
      <span class="mono text-xs text-neutral-600">{server.authType}</span>
      <span class="ml-auto">{dockerBadge(server)}</span>
      <Button label="共享资源" variant="ghost" small hxGet={routes.pages.servers.resourcesByServerId(server.id)} hxTarget="#modal-root" hxSwap="innerHTML" />
      <Button label="检测" variant="ghost" small hxPost={routes.pages.servers.ByIdCheck(server.id)} hxTarget={`#server-${server.id}`} hxSwap="outerHTML" />
      {server.dockerStatus === "missing" ? (
        <Button label="安装 docker" small hxPost={routes.pages.servers.ByIdInstallDocker(server.id)} hxTarget={`#server-${server.id}`} hxSwap="outerHTML" />
      ) : null}
      <Button label="删除" variant="danger" small hxDelete={routes.pages.servers.ById(server.id)} hxTarget="#main" hxSwap="innerHTML" hxConfirm={`删除服务器「${server.name}」？`} />
    </div>
    {message ? (
      <pre class="mono mx-6 mb-3 max-h-40 overflow-auto rounded bg-harbor-950 p-2 text-xs whitespace-pre-wrap text-neutral-400">{message}</pre>
    ) : null}
  </div>
);

/** TOFU 确认：首次连接展示指纹，用户显式信任 */
export const TrustPrompt: Component<{ server: Server; fingerprint: string; algorithm: string }> = ({
  server, fingerprint, algorithm,
}) => (
  <div class="border-b border-brass-600/40 bg-brass-500/5 px-6 py-4" id={`server-${server.id}`}>
    <div class="text-sm font-medium text-brass-500">确认主机指纹 — {server.name}</div>
    <div class="mt-1 text-xs text-neutral-400">
      首次连接 <span class="mono">{server.host}</span>，请核对 {algorithm} 指纹：
    </div>
    <code class="mono mt-2 block rounded bg-harbor-950 p-2 text-xs text-brass-500">{fingerprint}</code>
    <form class="mt-3 flex gap-2" hx-post={routes.pages.servers.ByIdTrust(server.id)} hx-target={`#server-${server.id}`} hx-swap="outerHTML">
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <Button label="信任并继续" type="submit" small />
      <Button label="取消" variant="ghost" small hxGet={routes.pages.servers.ByIdCard(server.id)} hxTarget={`#server-${server.id}`} hxSwap="outerHTML" />
    </form>
  </div>
);

/** 服务器列表（页面主体，也是增删后的刷新片段——片段与页面同源） */
export const ServerList: Component<{ servers: Server[] }> = ({ servers }) => (
  <div class="flex h-full flex-col">
    <PageHeader title="服务器" sub={`${servers.length} 台`}>
      <button
        class="inline-flex items-center rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 hover:bg-brass-600"
        onclick="document.getElementById('add-server-form').classList.toggle('hidden')"
      >
        添加服务器
      </button>
    </PageHeader>

    <div id="add-server-form" class="hidden border-b border-harbor-800 bg-harbor-900 px-6 py-4">
      <form class="grid max-w-3xl grid-cols-2 gap-3" hx-post={routes.pages.servers.index()} hx-target="#main" hx-swap="innerHTML">
        <Field label="名称" name="name" placeholder="生产机" />
        <Field label="主机" name="host" placeholder="192.168.1.10" />
        <Field label="端口" name="port" type="number" value="22" />
        <Field label="用户" name="user" placeholder="root" />
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs text-neutral-500">认证方式</span>
          <select class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200" name="authType">
            <option value="key">私钥文件</option>
            <option value="agent">ssh-agent</option>
            <option value="password">密码</option>
          </select>
        </label>
        <Field label="私钥路径（key 时）" name="keyPath" placeholder="~/.ssh/id_ed25519" />
        <Field label="密码（password 时）" name="password" type="password" />
        <div class="col-span-2">
          <Button label="添加" type="submit" />
        </div>
      </form>
    </div>

    {servers.length === 0 ? (
      <Empty text="还没有服务器——添加一台，Dockyard 会检测它的 docker" />
    ) : (
      <div class="flex-1 overflow-auto">
        {servers.map((s) => (
          <ServerRow server={s} />
        ))}
      </div>
    )}
  </div>
);

// ── 共享资源弹窗（L2 partial：只属于服务器页，无独立 URL） ──

const DB_TYPES = ["postgres", "mysql", "redis", "mongo"] as const;

const ResourceRow: Component<{ resource: ServerResource; url: string | null }> = ({ resource, url }) => (
  <div class="flex flex-col gap-1 rounded border border-harbor-800 bg-harbor-950 px-3 py-2">
    <div class="flex items-center gap-2">
      <span class="text-sm font-medium text-neutral-200">{resource.name}</span>
      <span class="mono rounded bg-harbor-800 px-1.5 py-0.5 text-[11px] text-neutral-500">{resource.dbType}</span>
      <span class={`mono rounded px-1.5 py-0.5 text-[11px] ${url ? "bg-tide-400/10 text-tide-400" : "bg-brass-500/15 text-brass-500"}`}>
        {url ? "已就绪" : "未部署"}
      </span>
      <span class="ml-auto flex gap-2">
        {!url ? (
          <Button label="部署" small hxPost={routes.pages.servers.resourcesByIdDeploy(resource.id)} hxTarget="#shared-resources-body" hxSwap="innerHTML" />
        ) : null}
        <Button label="删除" variant="danger" small hxDelete={routes.pages.servers.resourcesById(resource.id)} hxTarget="#shared-resources-body" hxSwap="innerHTML"
          hxConfirm={`删除共享资源「${resource.name}」的记录？（远端容器和数据卷保留，需手动清理）`} />
      </span>
    </div>
    <div class="flex items-center gap-2 text-xs text-neutral-500">
      <span class="mono text-brass-500">{resource.envKey}</span>
      {url ? <span class="mono truncate text-neutral-600" title={url}>{url}</span> : <span>部署后自动生成连接串</span>}
    </div>
  </div>
);

/** 共享资源清单弹窗主体（部署/删除后整段刷新） */
export const ResourceListBody: Component<{
  server: Server;
  resources: { resource: ServerResource; url: string | null }[];
}> = ({ server, resources }) => (
  <div id="shared-resources-body" class="flex flex-col gap-3">
    {resources.length === 0 ? (
      <p class="text-xs text-neutral-500">还没有共享资源——部署 Redis / 数据库后，连接串会成为这台服务器的共享变量，任何项目都能引用。</p>
    ) : (
      resources.map((r) => <ResourceRow resource={r.resource} url={r.url} />)
    )}
    <form class="mt-2 grid grid-cols-[1fr_auto_auto] items-end gap-2 border-t border-harbor-800 pt-3" hx-post={routes.pages.servers.resources()} hx-target="#shared-resources-body" hx-swap="innerHTML">
      <input type="hidden" name="serverId" value={`${server.id}`} />
      <Field label="名称" name="name" placeholder="redis-main" />
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-xs text-neutral-500">类型</span>
        <select class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200" name="dbType">
          {DB_TYPES.map((d) => <option value={d}>{d}</option>)}
        </select>
      </label>
      <Button label="创建" type="submit" small />
    </form>
  </div>
);

export const SharedResourcesModal: Component<{
  server: Server;
  resources: { resource: ServerResource; url: string | null }[];
}> = ({ server, resources }) => (
  <Modal title={`共享资源 — ${server.name}`} width="lg">
    <div class="p-5">
      <ResourceListBody server={server} resources={resources} />
    </div>
  </Modal>
);

export async function resourcesModel(svc: ResourceService, servers: ServerService, serverId: number) {
  const server = (await servers.byId(serverId)) as Server;
  const resources = await svc.ofServer(serverId);
  const withUrl = await Promise.all(resources.map(async (r) => ({ resource: r, url: await svc.urlOf(r.id) })));
  return { server, resources: withUrl };
}

// ── GET 片段路由（挂载在 /api/servers 前缀下） ──
export default defineRoutes()
  .get("/:id/card", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    const server = await di.get("serverService").byId(params.id);
    return <ServerRow server={server!} />;
  })
  // 共享资源弹窗（挂 #modal-root）
  .get("/resources/:serverId", { params: t.Object({ serverId: t.Number() }) }, async ({ di, params }) => {
    const { server, resources } = await resourcesModel(di.get("resourceService"), di.get("serverService"), params.serverId);
    return <SharedResourcesModal server={server} resources={resources} />;
  });
