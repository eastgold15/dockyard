/**
 * 画布三源之一：实时状态（部署 status / running、容器 state）。
 * 唯一来源是 SSE /api/canvas/events（全局频道，端点见 live-provider 的 EVENTS_URL）；
 * 只进 LiveContext，不进 node.data。
 * Solid 版：LiveContext 里放的是 store 代理（由 app/board 创建），use* 返回 accessor
 * 函数——JSX 里 `live().status` 即细粒度订阅，一条 SSE 消息只让订阅的徽章重渲染。
 */
import { createContext, useContext } from "solid-js";
import type { ServiceState } from "../canvas.model";
import type { DeployStage } from "../../deploy/deploy.socket";

export type DeployStatus = "queued" | "building" | "transferring" | "deploying" | "success" | "failed";

/** 单 target 的实时态（LiveProvider 按键写入 store 时使用） */
export interface TargetLive {
  status: DeployStatus | null;
  running: boolean;
  stage: DeployStage | null;
  /** 状态所属的 run（服务端事件携带；日志抽屉据此判断实时状态是否属于正在看的那次 run） */
  runId: number | null;
}

/** 终态：run 已结束，running 必然为 false */
const TERMINAL: ReadonlySet<string> = new Set<DeployStatus>(["success", "failed"]);

export interface LiveState {
  targets: Record<number, TargetLive>;
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
  return () => ctx.targets[targetId] ?? { status: null, running: false, stage: null, runId: null };
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

/**
 * status/running 帧 → 单 target 的下一状态；其它帧返回 null。
 * 合并语义只此一份，LiveProvider 按键写 store 时调用（有单测）。
 */
export function nextTargetLive(
  prev: TargetLive | undefined,
  msg: Record<string, unknown>,
): TargetLive | null {
  const t = prev ?? { status: null, running: false, stage: null, runId: null };
  // runId 携带即更新：新一轮 run 开播后，旧 run 的状态不再冒充当前实时状态
  const runId = typeof msg.runId === "number" ? msg.runId : t.runId;
  if (msg.type === "status") {
    // stage 缺省保留旧值（粗 status 事件不带细步骤）；携带才更新
    const stage = "stage" in msg ? (msg.stage as DeployStage | null) : t.stage;
    const status = msg.status as DeployStatus;
    // 终态到了 running 必然结束。服务端 snapshot 对终态 run 只发 status、不发 running:false，
    // 不在这里推导的话，SSE 断线重连后卡片按钮会永久停在「部署中…」
    const running = TERMINAL.has(status) ? false : t.running;
    return { ...t, status, stage, running, runId };
  }
  if (msg.type === "running") {
    // 新 run 开播清旧 stage（上一轮的断点不能污染本轮步骤条）
    return msg.running ? { ...t, running: true, stage: null, runId } : { ...t, running: false, runId };
  }
  return null;
}

/**
 * log 帧 → 单 target 的下一日志块（纯函数，LiveProvider 按键写 store 时调用，有单测）。
 * 同 run 追加、换 run 重置；超过 LOG_TAIL_LIMIT 丢最旧行（完整日志在服务端）。
 * runId 缺失的坏帧：沿用当前块所属 run；连当前块都没有则无从归属，返回 null 丢弃。
 */
export function nextLog(
  cur: LiveState["logs"][number] | undefined,
  msg: Record<string, unknown>,
): LiveState["logs"][number] | null {
  const runId = typeof msg.runId === "number" ? msg.runId : cur?.runId;
  if (runId === undefined) return null;
  const base = cur && cur.runId === runId ? cur.lines : [];
  // lines 必须是字符串数组：坏帧（字符串/数字/对象）若直接展开会逐字符拆行或抛错，
  // 整帧日志静默丢失；非数组按空帧处理（保留 base，不污染）
  const incoming = Array.isArray(msg.lines)
    ? (msg.lines as unknown[]).filter((l): l is string => typeof l === "string")
    : [];
  return { runId, lines: [...base, ...incoming].slice(-LOG_TAIL_LIMIT) };
}
