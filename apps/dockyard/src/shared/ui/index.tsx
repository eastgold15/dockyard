import type { Component } from "@elysiax/htmx";

// ── L4 渲染件层（page-architecture.md §五）：无状态、无业务、无路由感知 ──
// 准入条件：给它 props 出 HTML；带业务语义的组件不许进这层。

export const Button: Component<{
  label?: string;
  variant?: "primary" | "ghost" | "danger";
  type?: string;
  small?: boolean;
  hxGet?: string;
  hxPost?: string;
  hxDelete?: string;
  hxTarget?: string;
  hxSwap?: string;
  hxConfirm?: string;
}> = ({ label, variant = "primary", type = "button", small, hxGet, hxPost, hxDelete, hxTarget, hxSwap, hxConfirm }) => {
  const cls = {
    primary: "bg-brass-500 text-harbor-950 font-semibold hover:bg-brass-600",
    ghost: "border border-harbor-700 text-neutral-400 hover:bg-harbor-800 hover:text-neutral-200",
    danger: "text-signal-500 border border-transparent hover:bg-signal-500/10",
  }[variant];
  return (
    <button
      class={`inline-flex items-center justify-center rounded transition-colors ${small ? "px-2 py-0.5 text-xs" : "px-3 py-1.5 text-sm"} ${cls}`}
      type={type}
      hx-get={hxGet}
      hx-post={hxPost}
      hx-delete={hxDelete}
      hx-target={hxTarget}
      hx-swap={hxSwap}
      hx-confirm={hxConfirm}
    >
      {label ?? "按钮"}
    </button>
  );
};

export const Badge: Component<{
  label: string;
  tone?: "ok" | "warn" | "err" | "muted";
}> = ({ label, tone = "muted" }) => {
  const cls = {
    ok: "bg-tide-400/10 text-tide-400",
    warn: "bg-brass-500/15 text-brass-500",
    err: "bg-signal-500/15 text-signal-500",
    muted: "bg-harbor-800 text-neutral-500",
  }[tone];
  return <span class={`rounded px-1.5 py-0.5 text-[11px] font-medium mono ${cls}`}>{label}</span>;
};

/** 视图页头：标题 + 副标题 + 右侧操作区 */
export const PageHeader: Component<{ title: string; sub?: string }> = ({ title, sub, children }) => (
  <div class="flex h-14 shrink-0 items-center justify-between border-b border-harbor-800 px-6">
    <div class="flex items-baseline gap-3">
      <h2 class="text-sm font-semibold tracking-wide text-neutral-100">{title}</h2>
      {sub ? <span class="text-xs text-neutral-500">{sub}</span> : null}
    </div>
    <div class="flex items-center gap-2">{children}</div>
  </div>
);

export const Field: Component<{ label: string; name: string; type?: string; placeholder?: string; value?: string; required?: boolean }> = ({
  label, name, type = "text", placeholder, value, required,
}) => (
  <label class="flex flex-col gap-1 text-sm">
    <span class="text-xs text-neutral-500">{label}</span>
    <input
      class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-brass-500"
      type={type}
      name={name}
      placeholder={placeholder ?? ""}
      value={value ?? ""}
      {...(required ? { required: true } : {})}
    />
  </label>
);

/** 空态（7.3）：每个列表/数据区域必须有空态分支 */
export const Empty: Component<{ text: string }> = ({ text }) => (
  <div class="flex flex-1 items-center justify-center text-sm text-neutral-600">
    {text}
  </div>
);

/**
 * 模态弹窗（规格统一容器）：遮罩 60% 黑、z-60、圆角 8px、宽三档（sm 384 / md 480 / lg 672）、
 * Esc 与遮罩点击关闭。children 放进独立滚动区。确认型对话框不走这里——用 hx-confirm
 * （layout 的全局 <dialog> 单例接管）。
 */
export const Modal: Component<{ title: string; sub?: string; width?: "sm" | "md" | "lg" }> = ({
  title, sub, width = "md", children,
}) => {
  const w = { sm: "w-96", md: "w-[30rem]", lg: "w-[42rem]" }[width];
  return (
    <div
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 outline-none"
      tabindex="-1"
      {...{
        autofocus: "autofocus",
        onkeydown: "if(event.key==='Escape')this.remove()",
        onclick: "if(event.target===this)this.remove()",
      }}
    >
      <div
        class={`flex max-h-[85vh] ${w} max-w-full flex-col rounded-lg border border-harbor-700 bg-harbor-900 shadow-2xl`}
        role="dialog" aria-modal="true" aria-label={title}
      >
        <div class="flex items-start justify-between border-b border-harbor-800 px-5 py-4">
          <div class="flex flex-col gap-1">
            <h3 class="text-sm font-semibold text-neutral-100">{title}</h3>
            {sub ? <p class="text-xs text-neutral-500">{sub}</p> : null}
          </div>
          <button
            class="text-neutral-500 hover:text-neutral-200"
            aria-label="关闭"
            onclick="this.closest('.fixed.inset-0').remove()"
          >✕</button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};

export { cn } from "./cn";
export type { ClassValue } from "./cn";
