/** @jsxImportSource solid-js */
/**
 * 全站共享控件（L4 渲染件层）：无业务、无状态、无路由感知。
 * 样式只从 Panda recipe 取，行为由 Kobalte 提供；应用已无 htmx 页面，这里是唯一控件实现。
 */
import { Dialog } from "@kobalte/core/dialog";
import { For, Show, type JSX } from "solid-js";
import { badge, button, field, modal } from "../../../styled-system/recipes";
import { cx } from "../../../styled-system/css";

type Variant = "primary" | "ghost" | "danger";
type Size = "md" | "sm";

export function Button(props: {
  label?: string;
  variant?: Variant;
  size?: Size;
  type?: "button" | "submit";
  disabled?: boolean;
  class?: string;
  ariaLabel?: string;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  children?: JSX.Element;
}) {
  return (
    <button
      type={props.type ?? "button"}
      class={cx(
        button({ variant: props.variant ?? "primary", size: props.size ?? "md" }),
        props.class,
      )}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onClick={props.onClick}
    >
      {props.children ?? props.label ?? "按钮"}
    </button>
  );
}

export function Badge(props: {
  label?: string;
  tone?: "ok" | "warn" | "err" | "muted";
  class?: string;
  children?: JSX.Element;
}) {
  return (
    <span class={cx(badge({ tone: props.tone ?? "muted" }), props.class)}>
      {props.children ?? props.label}
    </span>
  );
}

/** 视图页头：标题 + 副标题 + 右侧操作区；min-h 64px、24px 水平内边距 */
export function PageHeader(props: {
  title: string;
  sub?: string;
  children?: JSX.Element;
}) {
  return (
    <div class="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-harbor-800 px-4 py-3 sm:px-6">
      <div class="flex items-baseline gap-3">
        <h2 class="text-xl font-semibold tracking-wide text-neutral-100">
          {props.title}
        </h2>
        {props.sub ? (
          <span class="text-xs text-neutral-500">{props.sub}</span>
        ) : null}
      </div>
      <div class="flex items-center gap-2">{props.children}</div>
    </div>
  );
}

/** 表单字段：永久标签 + 控件；控件外观由 field recipe 供给 */
export function Field(props: {
  label: string;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <label class={cx("flex flex-col gap-1 text-sm", props.class)}>
      <span class="text-xs text-neutral-500">{props.label}</span>
      {props.children}
    </label>
  );
}

/** 单行输入：label + input，常用组合 */
export function TextInput(props: {
  label: string;
  name?: string;
  type?: "text" | "number" | "password" | "search";
  placeholder?: string;
  value?: string;
  required?: boolean;
  autofocus?: boolean;
  class?: string;
  onInput?: JSX.EventHandlerUnion<HTMLInputElement, InputEvent>;
}) {
  return (
    <Field label={props.label} class={props.class}>
      <input
        class={field()}
        type={props.type ?? "text"}
        name={props.name}
        placeholder={props.placeholder ?? ""}
        value={props.value ?? ""}
        required={props.required}
        autofocus={props.autofocus}
        onInput={props.onInput}
      />
    </Field>
  );
}

/** 空态（7.3）：说明"为什么为空"与下一步 */
export function Empty(props: { text: string }) {
  return (
    <div class="flex flex-1 items-center justify-center px-6 text-sm text-neutral-400">
      {props.text}
    </div>
  );
}

/** 模态弹窗：Kobalte Dialog 供行为（Esc/焦点约束/aria），Panda modal recipe 供外观 */
export function Modal(props: {
  open: boolean;
  title: string;
  sub?: string;
  width?: "sm" | "md" | "lg";
  onClose: () => void;
  children: JSX.Element;
}) {
  const m = modal({ width: props.width ?? "md" });
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open: boolean) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class={m.overlay} />
        <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <Dialog.Content class={m.panel}>
            <div class={m.header}>
              <div class="flex flex-col gap-1">
                <Dialog.Title class={m.title}>{props.title}</Dialog.Title>
                {props.sub ? (
                  <Dialog.Description class={m.sub}>
                    {props.sub}
                  </Dialog.Description>
                ) : null}
              </div>
              <Dialog.CloseButton class={m.close} aria-label="关闭">
                ✕
              </Dialog.CloseButton>
            </div>
            <div class={m.body}>{props.children}</div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}

const NAV_ITEMS = [
  { href: "/projects", label: "项目" },
  { href: "/canvas", label: "画布" },
  { href: "/servers", label: "服务器" },
] as const;

/** 导航项公共样式（当前项底色 + aria-current） */
function navItemCls(active: boolean) {
  return cx(
    "flex min-h-11 items-center rounded px-3 py-2 text-sm",
    active
      ? "bg-harbor-800 text-neutral-100"
      : "text-neutral-400 hover:bg-harbor-800 hover:text-neutral-100",
    "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-brass-500",
  );
}

/**
 * 侧边导航（Solid 版，桌面）：与 htmx AppLayout 同一视觉（w-52、Harbor 色源、44px 命中区）。
 * 当前项按 location.pathname 判定 aria-current。窄屏入口用 MobileNav。
 */
export function Nav() {
  const current = location.pathname;
  return (
    <aside class="hidden w-52 shrink-0 flex-col border-r border-harbor-800 bg-harbor-900 sm:flex">
      <div class="flex h-14 shrink-0 items-center gap-2 border-b border-harbor-800 px-4 font-semibold tracking-wide text-neutral-100">
        ⚓ Dockyard
      </div>
      <nav class="flex flex-col gap-0.5 overflow-y-auto p-2">
        <For each={NAV_ITEMS}>
          {(item) => (
            <a
              href={item.href}
              aria-current={current === item.href ? "page" : undefined}
              class={navItemCls(current === item.href)}
            >
              {item.label}
            </a>
          )}
        </For>
      </nav>
    </aside>
  );
}

/**
 * 客户端页面外壳（原 AppLayout 的 Solid 形态）：侧边栏 + 主区。
 * 服务器不再出 HTML 壳，每个 client 页根组件挂同一份壳，视觉只有一处定义。
 */
export function AppShell(props: { children: JSX.Element }) {
  return (
    <div class="flex h-screen overflow-hidden">
      <Nav />
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <MobileNav />
        {props.children}
      </div>
    </div>
  );
}

/** 窄屏顶部导航：直接展示全部入口，不隐藏任何页面操作 */
export function MobileNav() {
  const current = location.pathname;
  return (
    <nav class="flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-harbor-800 bg-harbor-900 px-2 sm:hidden">
      <For each={NAV_ITEMS}>
        {(item) => (
          <a
            href={item.href}
            aria-current={current === item.href ? "page" : undefined}
            class={navItemCls(current === item.href)}
          >
            {item.label}
          </a>
        )}
      </For>
    </nav>
  );
}
