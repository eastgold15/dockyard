import { defineRoutes } from "../../../.elysiax";
import { routes } from "../../../.elysiax";
import { t } from "elysia";
import type { Component } from "@elysiax/htmx";
import type { Server } from "./schema";
import type { ServerResource } from "../resources/resources.socket";
import { parseMirrors, type ServerService } from "./servers.service";
import type { ResourceService } from "../resources/resources.socket";
import { Badge, Button, Empty, Field, Modal, PageHeader, cn } from "../../shared/ui";
import { field } from "../../../styled-system/recipes";

/** 本机/远程徽章（部署通道分界线：以 builtin 列为准，画布上两区硬隔离） */
const scopeBadge = (s: Server) =>
  s.builtin ? <Badge label="本机" tone="ok" /> : <Badge label="远程" tone="muted" />;

const dockerBadge = (s: Server) => {
  if (s.dockerStatus === "ok") return <Badge label={`docker ${s.dockerVersion ?? "ok"}`} tone="ok" />;
  if (s.dockerStatus === "missing") return <Badge label="无 docker" tone="err" />;
  return <Badge label="未检测" tone="muted" />;
};

export const ServerRow: Component<{ server: Server; message?: string }> = ({ server, message }) => (
  <div class="border-b border-harbor-800/60" id={`server-${server.id}`}>
    <div class="flex min-h-12 flex-wrap items-center gap-4 px-4 hover:bg-harbor-900 sm:px-6">
      <span class="text-sm font-medium text-neutral-100">{server.name}</span>
      {scopeBadge(server)}
      {server.builtin ? <Badge label="内置" tone="muted" /> : null}
      {/* 本机地址/用户由程序定死，不展示可编辑的 SSH 形参 */}
      <span class="mono text-xs text-neutral-500">
        {server.builtin ? "本地进程直连" : `${server.user}@${server.host}:${server.port}`}
      </span>
      {server.builtin ? null : <span class="mono text-xs text-neutral-500">{server.authType}</span>}
      <span class="ml-auto">{dockerBadge(server)}</span>
      <Button label="共享资源" variant="ghost" small hxGet={routes.pages.servers.resourcesByServerId(server.id)} hxTarget="#modal-root" hxSwap="innerHTML" />
      <Button label="检测" variant="ghost" small hxPost={routes.pages.servers.ByIdCheck(server.id)} hxTarget={`#server-${server.id}`} hxSwap="outerHTML" />
      {/* 本机不提供「安装 docker」：安装方式随发行版/权限，检测结果里已说明原因 */}
      {!server.builtin && server.dockerStatus === "missing" ? (
        <Button label="安装 docker" small hxPost={routes.pages.servers.ByIdInstallDocker(server.id)} hxTarget={`#server-${server.id}`} hxSwap="outerHTML" />
      ) : null}
      {server.builtin ? null : (
        <Button
          label="镜像源"
          variant="ghost"
          small
          onclick={`document.getElementById('mirror-panel-${server.id}').classList.toggle('hidden')`}
        />
      )}
      {server.builtin ? null : (
        <Button label="删除" variant="danger" small hxDelete={routes.pages.servers.ById(server.id)} hxTarget="#main" hxSwap="innerHTML" hxConfirm={`删除服务器「${server.name}」？`} />
      )}
    </div>
    {/* 镜像源配置面板（默认收起；应用后整行重渲染，面板随行隐藏） */}
    {server.builtin ? null : (
      <div id={`mirror-panel-${server.id}`} class="hidden border-t border-harbor-800/60 bg-harbor-950 px-4 py-3 sm:px-6">
        <form
          class="flex max-w-xl flex-col gap-2"
          hx-post={routes.pages.servers.ByIdRegistryMirrors(server.id)}
          hx-target={`#server-${server.id}`}
          hx-swap="outerHTML"
        >
          <Field label="Docker 镜像源（每行一个，docker.io 加速地址）">
            <textarea
              class={cn(field(), "mono min-h-20 py-2 text-xs")}
              name="mirrors"
              rows="3"
              placeholder={"https://docker.1ms.run\nhttps://docker.m.daocloud.io"}
            >
              {parseMirrors(server).join("\n")}
            </textarea>
          </Field>
          <p class="text-xs text-neutral-500">
            应用会把列表合并进远端 /etc/docker/daemon.json（追加不覆盖），并重启 dockerd——会短暂中断这台服务器上的运行中容器。
          </p>
          <div>
            <Button label="保存并应用" type="submit" small />
          </div>
        </form>
      </div>
    )}
    {message ? (
      <pre class="mono mx-4 mb-3 max-h-40 overflow-auto rounded bg-harbor-950 p-2 text-xs whitespace-pre-wrap text-neutral-400 sm:mx-6">{message}</pre>
    ) : null}
  </div>
);

/** TOFU 确认：首次连接展示指纹，用户显式信任 */
export const TrustPrompt: Component<{ server: Server; fingerprint: string; algorithm: string }> = ({
  server, fingerprint, algorithm,
}) => (
  <div class="border-b border-brass-600/40 bg-brass-500/5 px-4 py-4 sm:px-6" id={`server-${server.id}`}>
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
      <Button label="添加服务器" onclick="document.getElementById('add-server-form').classList.toggle('hidden')" />
    </PageHeader>

    <div id="add-server-form" class="hidden border-b border-harbor-800 bg-harbor-900 px-4 py-4 sm:px-6">
      <form class="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2" hx-post={routes.pages.servers.index()} hx-target="#main" hx-swap="innerHTML">
        <Field label="名称" name="name" placeholder="生产机" />
        <Field label="主机" name="host" placeholder="192.168.1.10（本机由程序自动认领）" />
        <Field label="端口" name="port" type="number" value="22" />
        <Field label="用户" name="user" placeholder="root" />
        <Field label="认证方式">
          <select class={field()} name="authType">
            <option value="key">私钥文件</option>
            <option value="agent">ssh-agent</option>
            <option value="password">密码</option>
          </select>
        </Field>
        <Field label="私钥路径（key 时）" name="keyPath" placeholder="~/.ssh/id_ed25519" />
        <Field label="密码（password 时）" name="password" type="password" />
        <div class="col-span-1 sm:col-span-2">
          <Field label="Docker 镜像源（每行一个，可选；添加后可在行内「保存并应用」）">
            <textarea
              class={cn(field(), "mono min-h-16 py-2 text-xs")}
              name="registryMirrors"
              rows="2"
              placeholder={"https://docker.1ms.run\nhttps://docker.m.daocloud.io"}
            />
          </Field>
        </div>
        <div class="col-span-1 sm:col-span-2">
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
      <Badge label={resource.dbType} tone="muted" />
      <Badge label={url ? "已就绪" : "未部署"} tone={url ? "ok" : "warn"} />
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
      {url ? <span class="mono truncate text-neutral-400" title={url}>{url}</span> : <span>部署后自动生成连接串</span>}
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
      <p class="text-xs text-neutral-400">还没有共享资源——部署 Redis / 数据库后，连接串会成为这台服务器的共享变量，任何项目都能引用。</p>
    ) : (
      resources.map((r) => <ResourceRow resource={r.resource} url={r.url} />)
    )}
    <form class="mt-2 grid grid-cols-1 gap-2 border-t border-harbor-800 pt-3 sm:grid-cols-[1fr_auto_auto] sm:items-end" hx-post={routes.pages.servers.resources()} hx-target="#shared-resources-body" hx-swap="innerHTML">
      <input type="hidden" name="serverId" value={`${server.id}`} />
      <Field label="名称" name="name" placeholder="redis-main" />
      <Field label="类型">
        <select class={field()} name="dbType">
          {DB_TYPES.map((d) => <option value={d}>{d}</option>)}
        </select>
      </Field>
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
