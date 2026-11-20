/** @jsxImportSource @solidjs/web */
/** 节点卡共用原子：徽章、域名链接、两个实时状态点。 */
import type { JSX } from "@solidjs/web";
import type { DomainBadge } from "../../canvas.model";
import { useServiceState, useTargetLive } from "../infra/live";
import { badge } from "../../../../../styled-system/recipes";

const STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  building: "构建中",
  transferring: "传输中",
  deploying: "部署中",
  success: "运行中",
  failed: "失败",
};

export function Badge(props: {
  tone: "ok" | "warn" | "err" | "muted";
  children: JSX.Element;
}) {
  return <span class={badge({ tone: props.tone })}>{props.children}</span>;
}

export const DomainLink = (props: { d: DomainBadge }) => (
  <a
    class={`nodrag block truncate text-[11px] mono transition-colors ${
      props.d.sslStatus === "active"
        ? "text-tide-400 hover:text-tide-300"
        : props.d.dnsStatus === "mismatch"
          ? "text-signal-500 hover:text-signal-400"
          : "text-brass-500 hover:text-brass-400"
    }`}
    href={`https://${props.d.hostname}`}
    target="_blank"
    rel="noreferrer"
  >
    {props.d.sslStatus === "active" ? "🔒" : "⏳"} {props.d.hostname}
  </a>
);

/** 容器实时状态点（SSE）：running 绿 / exited 红 / unknown 灰 */
export const StateDot = (props: { targetId: number; svcName: string }) => {
  const state = useServiceState(props.targetId, props.svcName);
  return (
    <span
      class={`h-2 w-2 shrink-0 rounded-full ${
        state() === "running"
          ? "bg-tide-400"
          : state() === "exited"
            ? "bg-signal-500"
            : "bg-neutral-600"
      }`}
      title={
        state() === "running"
          ? "运行中"
          : state() === "exited"
            ? "已停止"
            : "状态未知"
      }
    />
  );
};

/** target 级部署状态点（卡面小鱼点）：success 绿 / failed 红 / 进行中黄 / 未部署灰 */
export const StateDotRoot = (props: { targetId: number }) => {
  const live = useTargetLive(props.targetId);
  const cls = () => {
    const s = live().status;
    if (!s) return "bg-neutral-600";
    if (s === "success") return "bg-tide-400";
    if (s === "failed") return "bg-signal-500";
    return "bg-brass-500";
  };
  const title = () => {
    const s = live().status;
    if (!s) return "未部署";
    if (live().running) return "部署中…";
    return STATUS_LABEL[s] ?? s;
  };
  return (
    <span class={`h-2 w-2 shrink-0 rounded-full ${cls()}`} title={title()} />
  );
};
