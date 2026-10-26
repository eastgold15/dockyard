import { defineRealtime } from "@elysiax/core";

/**
 * 画布实时状态的事件总线（SSE 上游）。
 * 频道约定：全局常量频道 "canvas"（世界地图无项目边界）——部署状态迁移（deploy.service）
 * 与容器状态轮询（container-poller）往里推，SSE 端点（canvas.actions /events）订阅后推给浏览器。
 */
export type CanvasEvent =
  | { type: "status"; targetId: number; status: string }
  | { type: "running"; targetId: number; running: boolean }
  | { type: "state"; targetId: number; service: string; state: "running" | "exited" | "unknown" }
  // 部署日志增量（service 侧 100ms/50 行窗口合并后推送，不是逐行；日志抽屉订阅此事件免轮询）
  | { type: "log"; targetId: number; runId: number; lines: string[] };

/** 全局画布频道（世界地图唯一 SSE 频道） */
export const CANVAS_CHANNEL = "canvas";

export const events = defineRealtime<CanvasEvent>();
