/** @jsxImportSource solid-js */
/**
 * 实时状态的所有者：SSE 连接 + live store 建在 App 层，
 * Board（节点徽章/按钮）与 DrawerHost（部署行/日志弹窗）必须同处其下——
 * 只包住 Board 的话，兄弟位置的抽屉拿到的是 context 默认值（emptyLive），
 * 表现为「节点实时是好的、抽屉永远不刷新」。
 */
import { onCleanup, onMount, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { LiveContext, LOG_TAIL_LIMIT, nextTargetLive, type LiveState } from "./live";
import type { ServiceState } from "../canvas.model";

/** Canvas SSE 端点（部署 status/running、容器 state、日志、发现层变化） */
export const EVENTS_URL = "/api/canvas/events";

export function LiveProvider(props: { children: JSX.Element }) {
  const [live, setLive] = createStore<LiveState>({ targets: {}, services: {}, logs: {} });

  onMount(() => {
    const es = new EventSource(EVENTS_URL);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as Record<string, unknown>;
        if (msg.type === "log") {
          // 高频帧走按键写入：按 target 增量合并，不整树替换
          const id = msg.targetId as number;
          const runId = msg.runId as number;
          const incoming = (msg.lines as string[]) ?? [];
          const cur = live.logs[id];
          const base = cur && cur.runId === runId ? cur.lines : [];
          setLive("logs", id, { runId, lines: [...base, ...incoming].slice(-LOG_TAIL_LIMIT) });
          return;
        }
        if (msg.type === "discovery") {
          // 发现层集合变化（容器启停/增删）：发现卡数据是 /board 现查的快照 → 重拉结构
          document.body.dispatchEvent(new CustomEvent("refresh"));
          return;
        }
        if (msg.type === "state") {
          setLive("services", `${msg.targetId}:${msg.service}`, msg.state as ServiceState);
          return;
        }
        // status/running：合并语义只有 nextTargetLive 一份实现（有单测），按 target 键写入
        const id = msg.targetId as number;
        const next = nextTargetLive(live.targets[id], msg);
        if (next) setLive("targets", id, next);
      } catch { /* 忽略坏帧 */ }
    };
    onCleanup(() => es.close());
  });

  return <LiveContext.Provider value={live}>{props.children}</LiveContext.Provider>;
}
