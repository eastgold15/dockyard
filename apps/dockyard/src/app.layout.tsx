import { defineLayout } from "@elysiax/core";
import { ConfirmScript, ToastRoot, ToastScripts } from "@elysiax/htmx";
// Panda recipe（panda/recipes.ts）：确认框复用 Button/Modal 面板样式，行为仍由 ConfirmScript 接管
import { button, modal } from "../styled-system/recipes";
import { cx } from "../styled-system/css";

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
      {/* 侧边导航与全局同走 Harbor 色源（规范：nav 与内容不许不同色源）；桌面 w-52 静态基线，
          窄屏折叠为离屏抽屉（折叠入口在 #main 外的移动顶栏），不依赖当前路径，也不替换 #main 片段。
          当前项状态待 layout 契约带路径后补，不伪造路径。 */}
      <aside
        id="site-nav"
        class="fixed inset-y-0 left-0 z-40 flex hidden w-52 flex-col border-r border-harbor-800 bg-harbor-900 sm:static sm:flex sm:shrink-0"
      >
        <div class="flex h-14 shrink-0 items-center gap-2 border-b border-harbor-800 px-4 font-semibold tracking-wide text-neutral-100">
          ⚓ Dockyard
          <button
            type="button"
            class={cx(button({ variant: "ghost", size: "sm" }), "ml-auto sm:hidden")}
            aria-label="关闭导航"
            onclick="const n=document.getElementById('site-nav');n.classList.add('hidden');const t=document.getElementById('nav-toggle');if(t)t.setAttribute('aria-expanded','false')"
          >✕</button>
        </div>
        <nav class="flex flex-col gap-0.5 overflow-y-auto p-2">
          <a
            class="flex min-h-11 items-center rounded px-3 py-2 text-sm text-neutral-400 hover:bg-harbor-800 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-brass-500"
            href="/projects"
          >项目</a>
          <a
            class="flex min-h-11 items-center rounded px-3 py-2 text-sm text-neutral-400 hover:bg-harbor-800 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-brass-500"
            href="/canvas"
          >画布</a>
          <a
            class="flex min-h-11 items-center rounded px-3 py-2 text-sm text-neutral-400 hover:bg-harbor-800 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-brass-500"
            href="/servers"
          >服务器</a>
        </nav>
      </aside>

      {/* #main 外包一层：移动顶栏放在 #main 外，页面片段 hx-swap 只替换 #main，不波及折叠入口 */}
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div class="flex h-12 shrink-0 items-center border-b border-harbor-800 bg-harbor-900 px-4 sm:hidden">
          <button
            id="nav-toggle"
            type="button"
            class={button({ variant: "ghost", size: "sm" })}
            aria-label="打开导航"
            aria-controls="site-nav"
            aria-expanded="false"
            onclick="const n=document.getElementById('site-nav');const closed=n.classList.toggle('hidden');this.setAttribute('aria-expanded',closed?'false':'true')"
          >导航</button>
        </div>
        <main id="main" class="flex min-w-0 flex-1 flex-col overflow-hidden">
          {content}
        </main>
      </div>

      <div id="modal-root" />
      {/* hx-confirm 的样式化确认框单例（htmx 侧对标 Kobalte AlertDialog：
          原生 <dialog>.showModal() 自带 Esc/焦点约束/::backdrop，行为语义对齐） */}
      <dialog
        id="hx-confirm-dialog"
        role="alertdialog"
        aria-label="确认操作"
        class={cx(
          modal({ width: "sm" }).panel,
          // 原生 <dialog> 的定位与 ::backdrop 不能由普通 overlay slot 承担，保留必要类：
          // 固定居中、窄屏留边距、p-5、backdrop 遮罩；panel 自带 sm(384px)/圆角/边框/Harbor 表面。
          // panel 的 display:flex 不能覆盖原生 dialog 关闭态，故由 hidden/open:flex 接管显隐。
          "hidden open:flex fixed top-1/2 left-1/2 m-0 max-w-[calc(100%_-_2rem)]! -translate-x-1/2 -translate-y-1/2 p-5 text-neutral-100 outline-none backdrop:bg-black/60",
        )}
        {...{ closedby: "closerequest" }}
      >
        <p class="text-sm leading-6" data-confirm-question />
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class={button({ variant: "ghost", size: "md" })}
            onclick="this.closest('dialog').close()"
          >取消</button>
          <button
            type="button"
            data-confirm-ok
            autofocus
            class={button({ variant: "danger", size: "md" })}
          >确认</button>
        </div>
      </dialog>
      <ToastRoot />
      <ToastScripts />
      <ConfirmScript />
    </body>
  </html>
));
