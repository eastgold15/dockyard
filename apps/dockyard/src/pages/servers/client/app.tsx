/** @jsxImportSource solid-js */
/**
 * 服务器列表页（整页 Solid client）：页面状态、请求编排与列表渲染。
 * 数据走 /api/servers 的 JSON 端点；写操作成功后服务端返回最新列表/行，客户端直接替换。
 */
import { createSignal, For, onMount, Show } from "solid-js";
import type { CheckResult } from "../servers.types";
import type { Server } from "../schema";
import { api, unwrap } from "./api";
import { ResourcesModal } from "./resources";
import {
  AddServerModal,
  ServerRow,
  TrustPrompt,
  type AddServerBody,
} from "./rows";
import {
  AppShell,
  Button,
  Empty,
  PageHeader,
} from "@/shared/solid-ui/index";
import {
  FeedbackHost,
  confirmAction,
  toast,
} from "@/shared/solid-ui/feedback";

interface TrustState {
  server: Server;
  fingerprint: string;
  algorithm: string;
}

/** need-trust 之外的失败原因转文案差异：安装/信任共用检测结果回显 */
function checkMessage(result: CheckResult): string | undefined {
  if (result.ok) {
    return `连接成功，docker ${result.dockerVersion}${
      result.warning ? `\n⚠️ ${result.warning}` : ""
    }`;
  }
  if (result.reason === "need-trust") return undefined;
  return result.message;
}

export function App() {
  const [servers, setServers] = createSignal<Server[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [addOpen, setAddOpen] = createSignal(false);
  const [busyId, setBusyId] = createSignal<number | null>(null);
  const [messages, setMessages] = createSignal<Record<number, string>>({});
  const [mirrorsFor, setMirrorsFor] = createSignal<number | null>(null);
  const [gitProxyFor, setGitProxyFor] = createSignal<number | null>(null);
  const [trust, setTrust] = createSignal<TrustState | null>(null);
  const [resourcesFor, setResourcesFor] = createSignal<number | null>(null);

  const mergeServer = (next: Server) =>
    setServers((prev) => prev.map((s) => (s.id === next.id ? next : s)));
  const setMessage = (id: number, message: string) =>
    setMessages((prev) => ({ ...prev, [id]: message }));

  const reload = async () => {
    const model = await unwrap(api.get());
    setServers(model.servers);
  };

  onMount(() => {
    void reload()
      .catch((e) => toast((e as Error).message, "err"))
      .finally(() => setLoading(false));
  });

  /** 统一异步动作：同一时间只允许一个行内操作，错误进 toast */
  const run = async (id: number, fn: () => Promise<void>) => {
    if (busyId() !== null) return;
    setBusyId(id);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusyId(null);
    }
  };

  const applyCheck = (id: number, server: Server, result: CheckResult) => {
    mergeServer(server);
    if (!result.ok && result.reason === "need-trust") {
      setTrust({
        server,
        fingerprint: result.fingerprint,
        algorithm: result.algorithm,
      });
      return;
    }
    setMessage(id, checkMessage(result) ?? "检测完成");
  };

  const check = (server: Server) =>
    run(server.id, async () => {
      const { server: next, result } = await unwrap(
        api({ id: server.id }).check.post(),
      );
      applyCheck(server.id, next, result);
    });

  const trustCurrent = () =>
    run(trust()?.server.id ?? 0, async () => {
      const state = trust();
      if (!state) return;
      const { server: next, result } = await unwrap(
        api({ id: state.server.id }).trust.post({
          fingerprint: state.fingerprint,
        }),
      );
      setTrust(null);
      applyCheck(state.server.id, next, result);
    });

  const install = (server: Server) =>
    run(server.id, async () => {
      const { server: next, code, output } = await unwrap(
        api({ id: server.id })["install-docker"].post(),
      );
      mergeServer(next);
      setMessage(
        server.id,
        code === 0
          ? `docker 安装完成\n${output.slice(-500)}`
          : `安装失败（exit ${code}）\n${output.slice(-1000)}`,
      );
    });

  const saveMirrors = (server: Server, text: string) =>
    run(server.id, async () => {
      const { server: next, result } = await unwrap(
        api({ id: server.id })["registry-mirrors"].post({ mirrors: text }),
      );
      mergeServer(next);
      setMessage(server.id, result.output);
      setMirrorsFor(null);
    });

  const saveGitProxy = (server: Server, url: string) =>
    run(server.id, async () => {
      const next = await unwrap(
        api({ id: server.id })["git-proxy"].patch({ gitProxy: url }),
      );
      mergeServer(next);
      setMessage(server.id, url ? `Git 代理已设为 ${url}` : "Git 代理已清除");
      setGitProxyFor(null);
    });

  const remove = async (server: Server) => {
    const ok = await confirmAction({
      title: `删除服务器「${server.name}」？`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    await run(server.id, async () => {
      const model = await unwrap(api({ id: server.id }).delete());
      setServers(model.servers);
      toast("服务器已删除", "ok");
    });
  };

  const add = async (body: AddServerBody) => {
    try {
      const model = await unwrap(api.post(body));
      setServers(model.servers);
      setAddOpen(false);
      toast(`服务器「${body.name}」已添加`, "ok");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  return (
    <AppShell>
      <div class="flex min-h-0 flex-1 flex-col">
          <PageHeader title="服务器" sub={`${servers().length} 台`}>
            <Button
              label="添加服务器"
              onClick={() => setAddOpen(true)}
            />
          </PageHeader>

          <Show
            when={!loading()}
            fallback={
              <div class="flex flex-1 items-center justify-center text-sm text-neutral-400">
                正在加载服务器…
              </div>
            }
          >
            <Show
              when={servers().length > 0}
              fallback={
                <Empty text="还没有服务器——添加一台，Dockyard 会检测它的 docker" />
              }
            >
              <div class="flex-1 overflow-auto">
                <For each={servers()}>
                  {(server) => (
                    <Show
                      when={
                        trust()?.server.id === server.id ? trust() : null
                      }
                      fallback={
                        <ServerRow
                          server={server}
                          message={messages()[server.id]}
                          mirrorsOpen={mirrorsFor() === server.id}
                          gitProxyOpen={gitProxyFor() === server.id}
                          busy={busyId() === server.id}
                          onToggleMirrors={() =>
                            setMirrorsFor((prev) =>
                              prev === server.id ? null : server.id,
                            )
                          }
                          onCheck={() => void check(server)}
                          onInstall={() => void install(server)}
                          onResources={() => setResourcesFor(server.id)}
                          onDelete={() => void remove(server)}
                          onToggleGitProxy={() =>
                            setGitProxyFor((prev) =>
                              prev === server.id ? null : server.id,
                            )
                          }
                          onSaveMirrors={(text) =>
                            void saveMirrors(server, text)
                          }
                          onSaveGitProxy={(url) =>
                            void saveGitProxy(server, url)
                          }
                        />
                      }
                    >
                      {(state) => (
                        <TrustPrompt
                          server={state().server}
                          fingerprint={state().fingerprint}
                          algorithm={state().algorithm}
                          busy={busyId() === server.id}
                          onTrust={() => void trustCurrent()}
                          onCancel={() => setTrust(null)}
                        />
                      )}
                    </Show>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>

      <Show when={addOpen()}>
        <AddServerModal
          onClose={() => setAddOpen(false)}
          onSubmit={(body) => void add(body)}
        />
      </Show>

      <Show when={resourcesFor()}>
        {(serverId) => (
          <ResourcesModal
            serverId={serverId()}
            onClose={() => setResourcesFor(null)}
          />
        )}
      </Show>

      <FeedbackHost />
    </AppShell>
  );
}
