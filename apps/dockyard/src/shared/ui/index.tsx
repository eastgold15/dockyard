import type { Component } from "@elysiax/htmx";
// Panda recipe（panda/recipes.ts）：htmx 侧与 Solid 侧共享同一视觉契约，运行时只产 className
import { badge, button, field, modal } from "../../../styled-system/recipes";

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
  return (
    <button
      class={button({ variant, size: small ? "sm" : "md" })}
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
  return <span class={badge({ tone })}>{label}</span>;
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
      class={field()}
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
 * 行为保持原样；close 关闭逻辑从依赖布局类选择器改为 data-shell 标识，避免与样式类耦合。
 */
export const Modal: Component<{ title: string; sub?: string; width?: "sm" | "md" | "lg" }> = ({
  title, sub, width = "md", children,
}) => {
  const { overlay, panel, header, title: titleCls, sub: subCls, close, body } = modal({ width });
  return (
    <div
      data-shell="overlay"
      class={overlay}
      tabindex="-1"
      {...{
        autofocus: "autofocus",
        onkeydown: "if(event.key==='Escape')this.remove()",
        onclick: "if(event.target===this)this.remove()",
      }}
    >
      <div
        class={panel}
        role="dialog" aria-modal="true" aria-label={title}
      >
        <div class={header}>
          <div class="flex flex-col gap-1">
            <h3 class={titleCls}>{title}</h3>
            {sub ? <p class={subCls}>{sub}</p> : null}
          </div>
          <button
            class={close}
            aria-label="关闭"
            onclick="this.closest('[data-shell=overlay]').remove()"
          >✕</button>
        </div>
        <div class={body}>{children}</div>
      </div>
    </div>
  );
};

export { cn } from "./cn";
export type { ClassValue } from "./cn";
