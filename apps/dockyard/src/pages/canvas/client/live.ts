/**
 * 画布三源之一：实时状态（部署 status / running、容器 state）。
 * 唯一来源是 SSE /api/canvas/projects/:id/events；只进 LiveContext，不进 node.data。
 * Solid 版：LiveContext 里放的是 store 代理（由 app/board 创建），use* 返回 accessor
 * 函数——JSX 里 `live().status` 即细粒度订阅，一条 SSE 消息只让订阅的徽章重渲染。
 */
import { createContext, useContext } from "solid-js";
import type { ServiceState } from "../canvas.model";

export type DeployStatus = "queued" | "building" | "transferring" | "deploying" | "success" | "failed";

export interface LiveState {
  targets: Record<number, { status: DeployStatus | null; running: boolean }>;
  services: Record<string, ServiceState>; // key = `${targetId}:${svcName}`
  // 部署日志增量聚合（SSE log 事件）：按 target 归并当前 run 的行，日志抽屉直接渲染。
  // runId 切换即重置；上限 5000 行防长构建撑爆内存（完整日志永远在服务端 chunks 里）。
  logs: Record<number, { runId: number; lines: string[] }>;
}

export const emptyLive: LiveState = { targets: {}, services: {}, logs: {} };

/** live.logs 单 target 行数上限（超出丢弃最旧行） */
export const LOG_TAIL_LIMIT = 5000;

/** 值约定：provider 传 Solid store 代理（属性读取即订阅） */
export const LiveContext = createContext<LiveState>(emptyLive);

/** 返回 accessor：JSX 里 `live().status` 细粒度订阅该目标的实时状态 */
export const useTargetLive = (targetId: number) => {
  const ctx = useContext(LiveContext);
  return () => ctx.targets[targetId] ?? { status: null, running: false };
};

export const useServiceState = (targetId: number, svcName: string) => {
  const ctx = useContext(LiveContext);
  return (): ServiceState => ctx.services[`${targetId}:${svcName}`] ?? "unknown";
};

/** 返回 accessor：该目标当前 run 的 SSE 日志行（无则 null——未开播或非当前 run） */
export const useDeployLog = (targetId: number) => {
  const ctx = useContext(LiveContext);
  return () => ctx.logs[targetId] ?? null;
};

/** SSE 消息 → LiveState 增量（纯函数；store 侧可配 produce 用，也可整体替换） */
export function applyLiveEvent(prev: LiveState, msg: Record<string, unknown>): LiveState {
  if (msg.type === "status") {
    const t = prev.targets[msg.targetId as number] ?? { status: null, running: false };
    return {
      ...prev,
      targets: { ...prev.targets, [msg.targetId as number]: { ...t, status: msg.status as DeployStatus } },
    };
  }
  if (msg.type === "running") {
    const t = prev.targets[msg.targetId as number] ?? { status: null, running: false };
    return {
      ...prev,
      targets: { ...prev.targets, [msg.targetId as number]: { ...t, running: Boolean(msg.running) } },
    };
  }
  if (msg.type === "state") {
    return {
      ...prev,
      services: { ...prev.services, [`${msg.targetId}:${msg.service}`]: msg.state as ServiceState },
    };
  }
  if (msg.type === "log") {
    const targetId = msg.targetId as number;
    const runId = msg.runId as number;
    const incoming = (msg.lines as string[]) ?? [];
    const cur = prev.logs[targetId];
    const base = cur && cur.runId === runId ? cur.lines : [];
    return {
      ...prev,
      logs: { ...prev.logs, [targetId]: { runId, lines: [...base, ...incoming].slice(-LOG_TAIL_LIMIT) } },
    };
  }
  return prev;
}
