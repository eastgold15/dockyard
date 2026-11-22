/** @jsxImportSource @solidjs/web */
/**
 * 变量来源勾选：app 从哪个库拿哪几个变量。
 *
 * Railway 模型的应用侧——库那边把变量摆出来（镜像变量 + 派生连接串），
 * 这里勾选要注入哪几个。勾的是「引用」，不是把值抄进手填区：
 * 值在部署前现取，库换密码后 app 自动跟随。
 */
import { createSignal, For, Show } from "solid-js";
import type { EnvBinding, EnvSource } from "@/pages/deploy/deploy.socket";
import type { ImageVar } from "@/pages/resources/resources.socket";
import type { EnvEntry } from "@/pages/deploy/deploy.socket";
import { Chip, Section } from "./shell";
import { button, field } from "../../../../../styled-system/recipes";
import { cx } from "../../../../../styled-system/css";

/** 敏感值打码（连接串里的密码段） */
function mask(value: string): string {
  return value.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/]*@/, "$1•••@");
}

/** 绑定的稳定标识 */
export function bindingKey(b: {
  sourceKind: string;
  sourceId: number;
}): string {
  return `${b.sourceKind}:${b.sourceId}`;
}

/**
 * 来源卡：来源名 + 变量清单（勾选框）。
 *
 * 默认勾选建议的连接串键（DATABASE_URL / REDIS_URL）——绝大多数 app 只需要这个。
 */
export function EnvSourceCard(props: {
  source: EnvSource;
  bindings: EnvBinding[];
  onChange: (bindings: EnvBinding[]) => void;
}) {
  const [revealed, setRevealed] = createSignal<Record<string, boolean>>({});
  const key = () => bindingKey(props.source);
  const binding = () =>
    props.bindings.find((b) => bindingKey(b) === key());
  const selected = () => new Set(binding()?.keys ?? []);
  const blocked = () => !props.source.sameServer;

  const toggle = (varKey: string, on: boolean) => {
    const cur = binding();
    const keys = new Set(cur?.keys ?? []);
    if (on) keys.add(varKey);
    else keys.delete(varKey);
    const next = { ...(cur ?? {}), sourceKind: props.source.sourceKind, sourceId: props.source.sourceId, keys: [...keys] };
    props.onChange(
      props.bindings.some((b) => bindingKey(b) === key())
        ? props.bindings.map((b) => (bindingKey(b) === key() ? next : b))
        : [...props.bindings, next],
    );
  };

  return (
    <div class="flex flex-col gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2">
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-neutral-200">
          {props.source.name}
        </span>
        <Chip tone="muted">{props.source.dbType}</Chip>
        <Show when={props.source.logical}>
          <Chip tone="muted">逻辑库</Chip>
        </Show>
        <Show when={blocked()}>
          <Chip tone="warn">跨服务器</Chip>
        </Show>
        <span class="ml-auto text-xs text-neutral-500">
          {selected().size > 0 ? `已选 ${selected().size} 项` : "未选"}
        </span>
      </div>

      <Show when={blocked()}>
        <p class="text-xs text-neutral-500">
          该来源在另一台服务器上，内网地址不可用。
        </p>
      </Show>

      <div class="flex flex-col gap-1">
        <For each={props.source.vars}>
          {(v) => (
            <div class="flex items-center gap-2">
              <input
                type="checkbox"
                class="mr-1 shrink-0 accent-brass-500"
                checked={selected().has(v.key)}
                disabled={blocked() || v.value === ""}
                onChange={(e) => toggle(v.key, e.currentTarget.checked)}
              />
              <span class="mono w-44 shrink-0 text-xs text-neutral-300">
                {v.key}
              </span>
              <Show
                when={v.secret && !revealed()[v.key]}
                fallback={
                  <span class="mono min-w-0 flex-1 truncate text-xs text-neutral-500">
                    {v.value || "（未填写）"}
                  </span>
                }
              >
                <span class="mono min-w-0 flex-1 truncate text-xs text-neutral-500">
                  {v.value ? mask(v.value) : "（未填写）"}
                </span>
              </Show>
              <Show when={v.secret}>
                <button
                  type="button"
                  class={button({ variant: "ghost", size: "sm" })}
                  onClick={() =>
                    setRevealed((cur) => ({ ...cur, [v.key]: !cur[v.key] }))
                  }
                >
                  {revealed()[v.key] ? "隐藏" : "显示"}
                </button>
              </Show>
              <Show when={v.description}>
                <span class="shrink-0 text-xs text-neutral-600">
                  {v.description}
                </span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/**
 * 变量来源区：所有可勾选的来源。
 *
 * 顶部一句说明「变量从哪来 → 勾选注入 → 部署前解析生效」，
 * 让用户知道勾了之后会发生什么。
 */
export function EnvSourcePicker(props: {
  sources: EnvSource[];
  bindings: EnvBinding[];
  onChange: (bindings: EnvBinding[]) => void;
}) {
  return (
    <Section
      title="变量来源"
      hint="勾选 = 部署时从该来源注入（存引用，不抄值）"
    >
      <Show
        when={props.sources.length > 0}
        fallback={
          <p class="text-xs text-neutral-500">
            还没有可用的变量来源。先在同一项目里部署一个数据库，或在服务器上添加共享资源。
          </p>
        }
      >
        <div class="flex flex-col gap-2">
          <For each={props.sources}>
            {(s) => (
              <EnvSourceCard
                source={s}
                bindings={props.bindings}
                onChange={props.onChange}
              />
            )}
          </For>
        </div>
      </Show>
    </Section>
  );
}

/**
 * 镜像变量表编辑器：按镜像声明渲染（中文名 + 说明 + 敏感打码）。
 *
 * 值仍以 KEY=VALUE 存在模板 env 里——声明表只决定「有哪些键、叫什么、哪些敏感」，
 * 不改变存储形态（省掉一次数据迁移）。
 */
export function ImageVarsEditor(props: {
  vars: ImageVar[];
  rows: EnvEntry[];
  onChange: (rows: EnvEntry[]) => void;
}) {
  const [revealed, setRevealed] = createSignal<Record<string, boolean>>({});
  const valueOf = (key: string) =>
    props.rows.find((r) => r.key === key)?.value ?? "";
  const setValue = (key: string, value: string) => {
    const hit = props.rows.findIndex((r) => r.key === key);
    props.onChange(
      hit >= 0
        ? props.rows.map((r, i) => (i === hit ? { ...r, value } : r))
        : [...props.rows, { key, value }],
    );
  };
  return (
    <div class="flex flex-col gap-2">
      <For each={props.vars}>
        {(v) => (
          <div class="flex flex-col gap-1">
            <div class="flex items-center gap-2">
              <span class="text-xs text-neutral-300">{v.label}</span>
              <span class="mono text-xs text-neutral-600">{v.key}</span>
              <Show when={v.description}>
                <span class="text-xs text-neutral-600">{v.description}</span>
              </Show>
            </div>
            <div class="flex items-center gap-1.5">
              <input
                class={cx(field(), "mono min-w-0 flex-1 text-xs")}
                type={
                  v.secret && !revealed()[v.key] ? "password" : "text"
                }
                value={valueOf(v.key)}
                onInput={(e) => setValue(v.key, e.currentTarget.value)}
              />
              <Show when={v.secret}>
                <button
                  type="button"
                  class={button({ variant: "ghost", size: "sm" })}
                  onClick={() =>
                    setRevealed((cur) => ({ ...cur, [v.key]: !cur[v.key] }))
                  }
                >
                  {revealed()[v.key] ? "隐藏" : "显示"}
                </button>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
