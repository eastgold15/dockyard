/** @jsxImportSource solid-js */
/** panes 共享壳：遮罩状态机 + Modal/Drawer + Section/Field/SubmitBtn 等通用件。 */
import { splitProps, type JSX } from "solid-js";
import { badge, button, drawer, field, modal } from "../../../../../styled-system/recipes";
import { cx } from "../../../../../styled-system/css";
// ── 壳与通用件 ──

/**
 * 遮罩点击关闭的状态机（Modal/Drawer 共用，别各写一份）：
 * 只有「同一根指针按下与松开都落在遮罩上」才关。click 的 target 是公共祖先，
 * 两个方向都会误判——面板内拖选文本拖到遮罩松手、或按住遮罩拖进面板松手。
 * 按 pointerId 记录按下位置：多指时互不覆盖；pointercancel 复位（手势被系统夺走不算点击）。
 *
 * 注：这是手写弹层（CLAUDE.md 倾向 Kobalte Dialog）。迁移会同时带来 Esc/焦点陷阱/aria，
 * 但涉及全部抽屉的视觉与交互验证，留作独立改动，不混在正确性修复里。
 */
function overlayClose(onClose: () => void) {
  const downOn = new Map<number, boolean>(); // pointerId → 按下时是否在遮罩
  let lastUpOnOverlay = false;
  return {
    onPointerDown(e: PointerEvent) {
      downOn.set(e.pointerId, e.target === e.currentTarget);
    },
    onPointerUp(e: PointerEvent) {
      lastUpOnOverlay =
        downOn.get(e.pointerId) === true && e.target === e.currentTarget;
      downOn.delete(e.pointerId);
    },
    onPointerCancel(e: PointerEvent) {
      downOn.delete(e.pointerId);
      lastUpOnOverlay = false;
    },
    onClick(e: MouseEvent) {
      if (!lastUpOnOverlay || e.target !== e.currentTarget) return;
      lastUpOnOverlay = false; // 一次按下只消费一次
      onClose();
    },
  };
}

export const Modal = (props: {
  title: string;
  wide?: boolean;
  children: JSX.Element;
  onClose: () => void;
}) => {
  const m = () => modal({ width: props.wide ? "lg" : "sm" });
  return (
    <div
      data-shell="overlay"
      class={m().overlay}
      {...overlayClose(() => props.onClose())}
    >
      <div data-shell="panel" class={m().panel}>
        <div class={m().header}>
          <h3 class={m().title}>{props.title}</h3>
          <button class={m().close} onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class={cx(m().body, "p-5")}>{props.children}</div>
      </div>
    </div>
  );
};

/** 右侧抽屉（Railway 式配置面板）：默认 576px、宽 768px，窄屏全宽（maxWidth 100% 兜底） */
export const Drawer = (props: {
  title: string;
  sub?: string;
  wide?: boolean;
  children: JSX.Element;
  onClose: () => void;
}) => {
  const d = () => drawer({ width: props.wide ? "lg" : "md" });
  return (
    <div
      data-shell="overlay"
      class={d().overlay}
      {...overlayClose(() => props.onClose())}
    >
      <div data-shell="panel" class={d().panel}>
        <div class={d().header}>
          <div class="flex flex-col gap-1">
            <h3 class={d().title}>{props.title}</h3>
            {props.sub ? <p class={d().sub}>{props.sub}</p> : null}
          </div>
          <button class={d().close} onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class={d().body}>{props.children}</div>
      </div>
    </div>
  );
};

export const Section = (props: {
  title: string;
  hint?: string;
  class?: string;
  children: JSX.Element;
}) => (
  <section class={`flex flex-col gap-2 ${props.class ?? ""}`}>
    <div class="flex items-baseline justify-between">
      <h4 class="text-xs font-semibold tracking-wide text-neutral-300 uppercase">
        {props.title}
      </h4>
      {props.hint ? (
        <span class="text-[11px] text-neutral-600">{props.hint}</span>
      ) : null}
    </div>
    {props.children}
  </section>
);

export const ErrorBanner = (props: { children: JSX.Element }) => (
  <div class="rounded bg-signal-500/15 px-3 py-2 text-xs text-signal-500">
    {props.children}
  </div>
);

export const Notice = (props: { children: JSX.Element }) => (
  <div class="rounded bg-tide-400/10 px-3 py-2 text-xs text-tide-400">
    {props.children}
  </div>
);

export const Chip = (props: {
  tone?: "ok" | "warn" | "err" | "muted";
  children: JSX.Element;
}) => (
  <span class={badge({ tone: props.tone ?? "muted" })}>{props.children}</span>
);

export const Field = (
  props: { label: string } & JSX.InputHTMLAttributes<HTMLInputElement>,
) => {
  const [local, rest] = splitProps(props, ["label"]);
  return (
    <label class="flex flex-col gap-1 text-sm">
      <span class="text-xs text-neutral-500">{local.label}</span>
      <input class={field()} {...rest} />
    </label>
  );
};

/** 提交按钮（busy 状态：识别要调 gh API / 部署要克隆，必须给用户即时反馈） */
export const SubmitBtn = (props: {
  label: string;
  busyLabel: string;
  busy: boolean;
}) => (
  <button
    type="submit"
    disabled={props.busy}
    class={cx(button({ variant: "primary", size: "md" }), "gap-2")}
  >
    {props.busy ? <span class="animate-spin">◌</span> : null}
    {props.busy ? props.busyLabel : props.label}
  </button>
);

