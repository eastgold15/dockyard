/** @jsxImportSource solid-js */
/**
 * 画布 client 的应用内反馈件：toast / 确认框 / 输入框——替代原生 alert/confirm/prompt。
 * 弹层基座用 @kobalte/core（Solid 官方生态的无头 UI，对标 Radix）：Esc、焦点约束、
 * aria 语义全部内置，我们只套 Tailwind 样式（harbor/brass/signal 色板）。
 * API 与原生用法同构（promise 化），<FeedbackHost/> 在 App 根部挂一次。
 */
import { Dialog } from "@kobalte/core/dialog";
import { Toast, toaster } from "@kobalte/core/toast";
import { createSignal, Show } from "solid-js";

// ── toast ─────────────────────────────────────────────────
type Tone = "info" | "ok" | "err";
const TONE_CLS: Record<Tone, string> = {
  info: "border-harbor-700 text-neutral-200",
  ok: "border-tide-400/40 text-tide-400",
  err: "border-signal-500/50 text-signal-500",
};

/** 轻量提示：右下角，4s 自动消失（Kobalte Toast 管理队列与滑出手势） */
export function toast(text: string, tone: Tone = "info") {
  toaster.show((props) => (
    <Toast
      toastId={props.toastId}
      class={`w-80 rounded border bg-harbor-900 px-3 py-2 text-sm shadow-xl ${TONE_CLS[tone]}`}
    >
      <Toast.Description>{text}</Toast.Description>
    </Toast>
  ));
}

// ── 确认框 ────────────────────────────────────────────────
interface ConfirmOpts {
  title: string;
  body?: string;
  confirmLabel?: string;
  /** 危险操作：确认按钮用 signal 红 */
  danger?: boolean;
}
const [confirmState, setConfirmState] = createSignal<(ConfirmOpts & { resolve(v: boolean): void }) | null>(null);

/** 应用内确认框（替代 confirm）；Esc/遮罩 = 取消 */
export function confirmAction(opts: ConfirmOpts): Promise<boolean> {
  // 已有弹窗时直接拒绝新调用，避免覆盖未决 promise
  if (confirmState()) return Promise.resolve(false);
  return new Promise((resolve) => setConfirmState({ ...opts, resolve }));
}
const closeConfirm = (v: boolean) => {
  const s = confirmState();
  if (s) { setConfirmState(null); s.resolve(v); }
};

// ── 输入框 ────────────────────────────────────────────────
interface PromptOpts { title: string; initial?: string; placeholder?: string }
const [promptState, setPromptState] = createSignal<(PromptOpts & { resolve(v: string | null): void }) | null>(null);

/** 应用内输入框（替代 prompt）；Esc/遮罩 = 取消（resolve null） */
export function promptAction(opts: PromptOpts): Promise<string | null> {
  if (promptState()) return Promise.resolve(null);
  return new Promise((resolve) => setPromptState({ ...opts, resolve }));
}
const closePrompt = (v: string | null) => {
  const s = promptState();
  if (s) { setPromptState(null); s.resolve(v); }
};

// ── 宿主组件 ──────────────────────────────────────────────
const panelCls = "w-96 rounded-lg border border-harbor-700 bg-harbor-900 p-5 shadow-2xl outline-none";
const overlayCls = "fixed inset-0 z-[60] bg-black/60";
const ghostBtn = "rounded border border-harbor-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-harbor-800";

export function FeedbackHost() {
  return (
    <>
      {/* 确认框（Dialog：Esc/遮罩关闭 = 取消，焦点约束内置） */}
      <Show when={confirmState()}>
        {(s) => (
          <Dialog open onOpenChange={(open: boolean) => { if (!open) closeConfirm(false); }}>
            <Dialog.Portal>
              <Dialog.Overlay class={overlayCls} />
              <div class="fixed inset-0 z-[60] flex items-center justify-center">
                <Dialog.Content class={panelCls}>
                  <Dialog.Title class="text-sm font-semibold text-neutral-100">{s().title}</Dialog.Title>
                  <Show when={s().body}>
                    <Dialog.Description class="mt-2 text-xs leading-5 text-neutral-400">{s().body}</Dialog.Description>
                  </Show>
                  <div class="mt-4 flex justify-end gap-2">
                    <button class={ghostBtn} onClick={() => closeConfirm(false)}>取消</button>
                    <button
                      class={`rounded px-3 py-1.5 text-sm font-semibold ${
                        s().danger
                          ? "bg-signal-500/15 text-signal-500 hover:bg-signal-500/25"
                          : "bg-brass-500 text-harbor-950 hover:bg-brass-600"
                      }`}
                      onClick={() => closeConfirm(true)}
                    >
                      {s().confirmLabel ?? "确认"}
                    </button>
                  </div>
                </Dialog.Content>
              </div>
            </Dialog.Portal>
          </Dialog>
        )}
      </Show>

      {/* 输入框 */}
      <Show when={promptState()}>
        {(s) => (
          <Dialog open onOpenChange={(open: boolean) => { if (!open) closePrompt(null); }}>
            <Dialog.Portal>
              <Dialog.Overlay class={overlayCls} />
              <div class="fixed inset-0 z-[60] flex items-center justify-center">
                <Dialog.Content class={panelCls}>
                  <Dialog.Title class="text-sm font-semibold text-neutral-100">{s().title}</Dialog.Title>
                  <form
                    class="mt-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = new FormData(e.currentTarget).get("value");
                      closePrompt(typeof v === "string" ? v : null);
                    }}
                  >
                    <input
                      name="value"
                      ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                      class="w-full rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-brass-500"
                      value={s().initial ?? ""}
                      placeholder={s().placeholder ?? ""}
                    />
                    <div class="mt-4 flex justify-end gap-2">
                      <button type="button" class={ghostBtn} onClick={() => closePrompt(null)}>取消</button>
                      <button type="submit" class="rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 hover:bg-brass-600">
                        确认
                      </button>
                    </div>
                  </form>
                </Dialog.Content>
              </div>
            </Dialog.Portal>
          </Dialog>
        )}
      </Show>

      {/* toast 区域：最顶层，右下角 */}
      <Toast.Region duration={4000} limit={4}>
        <Toast.List class="fixed right-6 bottom-6 z-[70] flex w-80 flex-col gap-2" />
      </Toast.Region>
    </>
  );
}
