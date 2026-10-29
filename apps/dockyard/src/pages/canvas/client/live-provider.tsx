/** @jsxImportSource solid-js */
/**
 * 实时状态的所有者：SSE 连接 + live store 建在 App 层，
 * Board（节点徽章/按钮）与 DrawerHost（部署行/日志弹窗）必须同处其下——
 * 只包住 Board 的话，兄弟位置的抽屉拿到的是 context 默认值（emptyLive），
 * 表现为「节点实时是好的、抽屉永远不刷新」。
 */
import { onCleanup, onMount, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { LiveContext, nextLog, nextTargetLive, type LiveState } from "./live";
import type { ServiceState } from "../canvas.model";
import { canvasPaths } from "./api";
import { emitRefresh } from "./ui";

/** Canvas SSE 端点（部署 status/running、容器 state、日志、发现层变化）——
 *  EventSource 走不了 Eden，但路径仍用 codegen 的 URL 助手，端点搬家不会漏改。 */
export const EVENTS_URL = canvasPaths.events();

/** 容器状态取值域（与 container-poller 的 SvcState 一致）：坏帧整帧丢弃 */
const SERVICE_STATES: ReadonlySet<string> = new Set<ServiceState>(["running", "exited", "unknown"]);

export function LiveProvider(props: { children: JSX.Element }) {
  const [live, setLive] = createStore<LiveState>({ targets: {}, services: {}, logs: {} });

  onMount(() => {
    const es = new EventSource(EVENTS_URL);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as Record<string, unknown>;
        if (msg.type === "discovery") {
          // 发现层集合变化（容器启停/增删）：发现卡数据是 /board 现查的快照 → 重拉结构。
          // 走 ui.ts 的唯一派发口：两处各发一份，改契约时必漏一处（画布静默不再更新）
          emitRefresh();
          return;
        }
        // 其余帧都按 target 归桶：targetId 缺失/非数字的坏帧会写进不可达的幽灵桶
        // （logs["undefined"]），没有 target 归属就整帧丢弃
        if (typeof msg.targetId !== "number") return;
        const id = msg.targetId;
        if (msg.type === "log") {
          // 高频帧走按键写入：按 target 增量合并，不整树替换；合并语义在 nextLog（有单测）
          const next = nextLog(live.logs[id], msg);
          if (next) setLive("logs", id, next);
          return;
        }
        if (msg.type === "state") {
          if (typeof msg.service !== "string") return;
          // state 与 status 同标准：未知值照写会把运行中的容器渲染成灰色「状态未知」
          if (typeof msg.state !== "string" || !SERVICE_STATES.has(msg.state)) return;
          setLive("services", `${id}:${msg.service}`, msg.state as ServiceState);
          return;
        }
        // status/running：合并语义只有 nextTargetLive 一份实现（有单测），按 target 键写入
        const next = nextTargetLive(live.targets[id], msg);
        if (next) setLive("targets", id, next);
      } catch { /* 忽略坏帧 */ }
    };
    onCleanup(() => es.close());
  });

  return <LiveContext.Provider value={live}>{props.children}</LiveContext.Provider>;
}
