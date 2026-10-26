/** @jsxImportSource solid-js */
/**
 * 容器交互式终端（Console Tab）：xterm.js ←→ WebSocket ←→ docker exec TTY（SSH 中继）。
 * 挂在 ServiceDrawer 的 Console Tab 里，组件卸载（onCleanup）即断开。
 */
import { onCleanup, onMount } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";

export function ConsoleView(props: { targetId: number; service?: string }) {
  let el!: HTMLDivElement;

  // 宿主按 tab 条件渲染本组件，挂载即建连、卸载即断开（targetId/service 在生命周期内不变）
  onMount(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#0b0f14" },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    // Eden Treaty WS：路径/params/query 类型安全（协议 ws/wss 由 treaty 自动推导）
    const sock = api.console({ id: props.targetId }).subscribe({ query: { svc: props.service || undefined } });
    sock.on("message", ({ data }) => term.write(typeof data === "string" ? data : ""));
    sock.on("close", () => term.write("\r\n\x1b[90m[连接已关闭]\x1b[0m\r\n"));
    const send = (msg: { type: string } & Record<string, unknown>) => sock.send(msg);
    term.onData((d) => send({ type: "input", data: d }));
    sock.on("open", () => send({ type: "resize", cols: term.cols, rows: term.rows }));

    const ro = new ResizeObserver(() => {
      fit.fit();
      send({ type: "resize", cols: term.cols, rows: term.rows });
    });
    ro.observe(el);

    onCleanup(() => {
      ro.disconnect();
      sock.close();
      term.dispose();
    });
  });

  return <div ref={el} class="h-full w-full" />;
}
