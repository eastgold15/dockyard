/** @jsxImportSource @solidjs/web */
/**
 * 容器交互式终端（Console Tab）：xterm.js ←→ WebSocket ←→ docker exec TTY（SSH 中继）。
 * 挂在 ServiceDrawer 的 Console Tab 里，组件卸载（onSettled 返回的清理函数）即断开。
 *
 * 尺寸处理抄自成熟的 xterm 集成做法（canopy / ttyd / wetty 同款）：
 * - 容器尺寸为 0 时用 requestAnimationFrame 重试，不在 0 尺寸上硬 fit（会得到 1x1）
 * - ResizeObserver 只合帧调度，真正 fit 后仅在 cols/rows 变化时才通知服务端
 * - WebSocket 处于 CONNECTING 时禁止 send（原生 WebSocket 会抛 InvalidStateError）
 * - 大段输出按帧批量 write，避免逐 chunk 触发 reflow
 */
import { onSettled } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../infra/api";

/** 容器无尺寸时的最大重试帧数（约 160ms；超过则放弃，等 ResizeObserver 再触发） */
const MAX_ZERO_RETRIES = 10;

export function ConsoleView(props: { targetId: number; service?: string }) {
  let el!: HTMLDivElement;

  // 宿主按 tab 条件渲染本组件，挂载即建连、卸载即断开（targetId/service 在生命周期内不变）
  onSettled(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
      theme: {
        background: "#0b0f14", // Harbor 950
        foreground: "#d4d4d8", // neutral-300
        cursor: "#5ec4b6", // Tide 400
        cursorAccent: "#0b0f14",
        selectionBackground: "#5ec4b666",
        // Harbor 原语：Signal 500 / Brass 500 / Tide 400
        red: "#d95d4e",
        brightRed: "#e88476",
        yellow: "#d9a441",
        brightYellow: "#e8bd6a",
        green: "#5ec4b6",
        brightGreen: "#8ad9cc",
        cyan: "#5eb0c4",
        blue: "#6f9ae0",
        magenta: "#b487d6",
        black: "#1b222b",
        brightBlack: "#62707d",
        white: "#d4d4d8",
        brightWhite: "#f4f4f5",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    let disposed = false;
    // WebSocket 处于 CONNECTING 时 send 会抛 InvalidStateError，
    // 而 ResizeObserver 的首次 observe 回调必然早于 open，故统一用 live 门控
    let live = false;
    const send = (msg: { type: string } & Record<string, unknown>) => {
      if (live) sock.send(msg);
    };

    /** 已通知服务端的网格尺寸；0 表示还没同步过 */
    let synced = { cols: 0, rows: 0 };
    const sendResize = () => {
      if (term.cols === synced.cols && term.rows === synced.rows) return;
      synced = { cols: term.cols, rows: term.rows };
      send({ type: "resize", cols: term.cols, rows: term.rows });
    };

    let fitRaf = 0;
    let zeroRetries = 0;
    /** 真正执行 fit（必须落在有尺寸的容器上） */
    const doFit = () => {
      fitRaf = 0;
      if (disposed) return;
      if (!el.clientWidth || !el.clientHeight) {
        // Tab 切换 / 首挂载时布局可能还没落地：逐帧重试，而不是在 0 尺寸上 fit
        if (zeroRetries++ < MAX_ZERO_RETRIES)
          fitRaf = requestAnimationFrame(doFit);
        return;
      }
      zeroRetries = 0;
      try {
        fit.fit();
      } catch {
        return; // 拖动改尺寸的中间态可能让 fit 失败，等下一次调度
      }
      sendResize();
    };
    /** 合帧调度：ResizeObserver 可能一帧内触发多次 */
    const scheduleFit = () => {
      if (fitRaf) cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(doFit);
    };

    // 服务端输出 → 终端：按帧批量写入，避免大段输出逐 chunk 触发 reflow
    let pendingOut = "";
    let outRaf = 0;
    const flushOut = () => {
      outRaf = 0;
      if (!pendingOut) return;
      const chunk = pendingOut;
      pendingOut = "";
      term.write(chunk);
    };
    const writeOut = (s: string) => {
      pendingOut += s;
      if (!outRaf) outRaf = requestAnimationFrame(flushOut);
    };

    // Eden Treaty WS：路径/params/query 类型安全（协议 ws/wss 由 treaty 自动推导）
    const sock = api
      .console({ id: props.targetId })
      .subscribe({ query: { svc: props.service || undefined } });

    sock.on("message", ({ data }) => {
      if (typeof data === "string") writeOut(data);
    });
    sock.on("close", () => {
      live = false;
      flushOut();
      term.write("\r\n\x1b[90m[连接已关闭]\x1b[0m\r\n");
    });
    sock.on("open", () => {
      live = true;
      // 建连时若 fit 还没落地，先发一次当前网格（xterm 缺省 80x24），
      // 随后的 fit 会再发真实尺寸
      if (!synced.cols) sendResize();
      else send({ type: "resize", cols: synced.cols, rows: synced.rows });
    });

    // Ctrl+C 有选区时走浏览器复制（不发 SIGINT）；xterm 默认会把它当 ^C
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        e.key.toLowerCase() === "c" &&
        term.hasSelection()
      ) {
        void navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      return true;
    });
    term.onData((d) => send({ type: "input", data: d }));

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(el);
    // 字体度量在字体加载完成前会偏小，首次 fit 得到的行列数不准
    void document.fonts?.ready.then(() => {
      if (!disposed) scheduleFit();
    });
    scheduleFit();

    // Solid 2：onSettled 内不能调 onCleanup（禁止作用域），改为返回清理函数
    return () => {
      disposed = true;
      if (fitRaf) cancelAnimationFrame(fitRaf);
      if (outRaf) {
        cancelAnimationFrame(outRaf);
        flushOut();
      }
      ro.disconnect();
      sock.close();
      term.dispose();
    };
  });

  return <div ref={el} class="h-full w-full" />;
}
