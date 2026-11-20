/** @jsxImportSource solid-js */
/**
 * 共享资源弹窗（servers 页私有）：服务器上可被任何项目引用的中间件目录。
 * 数据走 /api/servers/resources/*，写操作后服务端返回整段最新清单，客户端直接替换。
 */
import { createSignal, For, onMount, Show } from "solid-js";
import type { ResourcesResponse, ResourceItem } from "../servers.types";
import type { ServerResource } from "@/pages/resources/resources.socket";
import { api, unwrap } from "./api";
import { field } from "../../../../styled-system/recipes";
import { cx } from "../../../../styled-system/css";
import {
  Badge,
  Button,
  Empty,
  Field,
  Modal,
  TextInput,
} from "@/shared/solid-ui/index";
import { confirmAction, toast } from "@/shared/solid-ui/feedback";

const DB_TYPES = ["postgres", "mysql", "redis", "mongo"] as const;
type DbType = (typeof DB_TYPES)[number];
const isDbType = (v: string): v is DbType =>
  (DB_TYPES as readonly string[]).includes(v);

function ResourceRow(props: {
  item: ResourceItem;
  busy: boolean;
  onDeploy: () => void;
  onRemove: () => void;
}) {
  const resource = () => props.item.resource;
  return (
    <div class="flex flex-col gap-1 rounded border border-harbor-800 bg-harbor-950 px-3 py-2">
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium text-neutral-200">
          {resource().name}
        </span>
        <Badge label={resource().dbType} tone="muted" />
        <Badge
          label={props.item.url ? "已就绪" : "未部署"}
          tone={props.item.url ? "ok" : "warn"}
        />
        <span class="ml-auto flex gap-2">
          <Show when={!props.item.url}>
            <Button
              label="部署"
              size="sm"
              disabled={props.busy}
              onClick={props.onDeploy}
            />
          </Show>
          <Button
            label="删除"
            variant="danger"
            size="sm"
            disabled={props.busy}
            onClick={props.onRemove}
          />
        </span>
      </div>
      <div class="flex items-center gap-2 text-xs text-neutral-500">
        <span class="mono text-brass-500">{resource().envKey}</span>
        <Show
          when={props.item.url}
          fallback={<span>部署后自动生成连接串</span>}
        >
          <span
            class="mono truncate text-neutral-400"
            title={props.item.url ?? ""}
          >
            {props.item.url}
          </span>
        </Show>
      </div>
    </div>
  );
}

export function ResourcesModal(props: {
  serverId: number;
  onClose: () => void;
}) {
  const [data, setData] = createSignal<ResourcesResponse | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const load = async () => {
    try {
      setLoading(true);
      setData(await unwrap(api.resources({ id: props.serverId }).get()));
    } catch (e) {
      props.onClose();
      toast((e as Error).message, "err");
    } finally {
      setLoading(false);
    }
  };
  onMount(() => {
    void load();
  });

  const run = async (fn: () => Promise<ResourcesResponse>) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      setData(await fn());
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      toast(msg, "err");
    } finally {
      setBusy(false);
    }
  };

  const create = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const name = String(fd.get("name") ?? "").trim();
    const rawType = String(fd.get("dbType") ?? "");
    if (!name) {
      setError("请填写资源名称");
      return;
    }
    if (!isDbType(rawType)) {
      setError("请选择数据库类型");
      return;
    }
    void run(() =>
      unwrap(
        api.resources.post({
          serverId: props.serverId,
          name,
          dbType: rawType,
        }),
      ),
    );
    form.reset();
  };

  const deploy = (resource: ServerResource) =>
    run(() => unwrap(api.resources({ id: resource.id }).deploy.post()));

  const remove = async (resource: ServerResource) => {
    const ok = await confirmAction({
      title: `删除共享资源「${resource.name}」的记录？`,
      body: "远端容器和数据卷保留，需手动清理。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    void run(() => unwrap(api.resources({ id: resource.id }).delete()));
  };

  const serverName = () => data()?.server.name;

  return (
    <Modal
      open
      title={`共享资源${serverName() ? ` — ${serverName()}` : ""}`}
      width="lg"
      onClose={props.onClose}
    >
      <div class="flex flex-col gap-3 p-5">
        <Show
          when={!loading()}
          fallback={
            <p class="text-xs text-neutral-400">正在加载共享资源…</p>
          }
        >
          <Show
            when={(data()?.resources.length ?? 0) > 0}
            fallback={
              <Empty text="还没有共享资源——部署 Redis / 数据库后，连接串会成为这台服务器的共享变量，任何项目都能引用" />
            }
          >
            <For each={data()?.resources ?? []}>
              {(item) => (
                <ResourceRow
                  item={item}
                  busy={busy()}
                  onDeploy={() => void deploy(item.resource)}
                  onRemove={() => void remove(item.resource)}
                />
              )}
            </For>
          </Show>

          <form
            class="mt-2 grid grid-cols-1 gap-2 border-t border-harbor-800 pt-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              create(e.currentTarget);
            }}
          >
            <TextInput label="名称" name="name" placeholder="redis-main" />
            <Field label="类型">
              <select class={cx(field(), "w-auto")} name="dbType">
                <For each={DB_TYPES}>
                  {(d) => <option value={d}>{d}</option>}
                </For>
              </select>
            </Field>
            <Button
              label="创建"
              size="sm"
              type="submit"
              disabled={busy()}
              class="mb-0.5"
            />
          </form>
          <Show when={error()}>
            <p class="text-xs text-signal-500">{error()}</p>
          </Show>
        </Show>
      </div>
    </Modal>
  );
}
