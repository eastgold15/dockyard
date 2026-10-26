import { defineLayout } from "@elysiax/core";
import { ConfirmScript, ToastRoot, ToastScripts } from "@elysiax/htmx";

/**
 * 全局壳（L0 唯一 AppLayout）：全站外框 = <html><head>、侧边导航、toast。
 * 准入纪律：纯视觉边框，不查业务数据、不感知 URL 属于哪个页面。
 * 样式走 /api/assets/global.css（codegen 编译 tailwind 后内联产物）。
 */
export default defineLayout(({ title, content }) => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title ? `${title} · Dockyard` : "Dockyard"}</title>
      <link rel="stylesheet" href="/api/assets/global.css" />
      <script
        src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.11/dist/htmx.min.js"
        integrity="sha384-2OatzQy1H+Zd/IIrjr1TcuDGqLXeHhbooAyJY1KdQMKnr4LZ22k31GBLdYKHmVjg"
        crossorigin="anonymous"
      />
      <script
        src="https://cdn.jsdelivr.net/npm/idiomorph@0.7.4/dist/idiomorph-ext.min.js"
        integrity="sha384-SsScJKzATF/w6suEEdLbgYGsYFLzeKfOA6PY+/C5ZPxOSuA+ARquqtz/BZz9JWU8"
        crossorigin="anonymous"
      />
    </head>
    <body class="flex h-screen overflow-hidden">
      {/* 导航与全局同走 Harbor 色源（规范：nav 与内容不许不同色源）；当前项状态待 layout 契约带路径后补 */}
      <aside class="flex w-52 shrink-0 flex-col border-r border-harbor-800 bg-harbor-900">
        <div class="flex h-14 items-center gap-2 border-b border-harbor-800 px-4 font-semibold tracking-wide text-neutral-100">
          ⚓ Dockyard
        </div>
        <nav class="flex flex-col gap-0.5 p-2">
          <a class="rounded px-3 py-2 text-sm text-neutral-400 hover:bg-harbor-800 hover:text-neutral-100" href="/projects">项目</a>
          <a class="rounded px-3 py-2 text-sm text-neutral-400 hover:bg-harbor-800 hover:text-neutral-100" href="/canvas">画布</a>
          <a class="rounded px-3 py-2 text-sm text-neutral-400 hover:bg-harbor-800 hover:text-neutral-100" href="/servers">服务器</a>
        </nav>
      </aside>
      <main id="main" class="flex min-w-0 flex-1 flex-col overflow-hidden">
        {content}
      </main>
      <div id="modal-root" />
      {/* hx-confirm 的样式化确认框单例（htmx 侧对标 Kobalte AlertDialog：
          原生 <dialog>.showModal() 自带 Esc/焦点约束/::backdrop，行为语义对齐） */}
      <dialog
        id="hx-confirm-dialog"
        role="alertdialog"
        aria-label="确认操作"
        class="fixed top-1/2 left-1/2 m-0 w-96 max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-harbor-700 bg-harbor-900 p-5 text-neutral-100 shadow-2xl outline-none backdrop:bg-black/60"
        {...{ closedby: "closerequest" }}
      >
        <p class="text-sm leading-6" data-confirm-question />
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="rounded border border-harbor-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-harbor-800"
            onclick="this.closest('dialog').close()"
          >取消</button>
          <button
            type="button"
            data-confirm-ok
            autofocus
            class="rounded bg-signal-500/15 px-3 py-1.5 text-sm font-semibold text-signal-500 hover:bg-signal-500/25"
          >确认</button>
        </div>
      </dialog>
      <ToastRoot />
      <ToastScripts />
      <ConfirmScript />
    </body>
  </html>
));
