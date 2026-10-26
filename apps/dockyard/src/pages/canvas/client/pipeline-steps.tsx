/** @jsxImportSource solid-js */
/**
 * 六阶段流水线迷你步骤条（部署历史行内嵌）。
 * 执行序六段：源→构建→传输→运行→暴露→产物（产物落库实际在容器起来之后，
 * UI 诚实按执行序摆，不硬凑文档里 Artifact 的概念位）。
 *
 * 数据语义：stage 是 best-effort 进度指示（不是状态机）——
 * 进行中 = 实时 stage（SSE）；历史 run = 库值驻留段；failed 的驻留段即断点红叉。
 * stage=null（旁路逻辑库/存量行）整体降级，不渲染步骤条。
 */
import type { JSX } from "solid-js";
import type { DeployStage, DeployTarget, DeploymentRow } from "../../deploy/deploy.socket";

export const STAGES: readonly DeployStage[] = [
  "sourcing",
  "building",
  "transferring",
  "deploying",
  "exposing",
  "packaging",
];

export const STAGE_LABEL: Record<DeployStage, string> = {
  sourcing: "源",
  building: "构建",
  transferring: "传输",
  deploying: "运行",
  exposing: "暴露",
  packaging: "产物",
};

export type StepState = "done" | "active" | "failed" | "skipped" | "na" | "pending";

/** 形态/trigger 推导各段的静态姿态。run.stage===null → null（降级为旧徽章行） */
export function stagePosture(
  target: Pick<DeployTarget, "kind" | "repoUrl" | "instanceOf">,
  run: Pick<DeploymentRow, "trigger" | "stage">,
): { skipped: ReadonlySet<DeployStage>; na: ReadonlySet<DeployStage> } | null {
  if (run.stage == null) return null;
  const skipped = new Set<DeployStage>();
  const na = new Set<DeployStage>();
  if (run.trigger === "rollback") {
    // 回滚 = 激活旧产物：只走 运行→暴露，不产新产物
    skipped.add("sourcing").add("building").add("transferring").add("packaging");
    return { skipped, na };
  }
  if (run.trigger === "ship") {
    // 仅传输：止步传输段，后三段不适用
    na.add("deploying").add("exposing").add("packaging");
  }
  if (target.kind === "app" && target.repoUrl) skipped.add("transferring"); // github 免传输（就地构建）
  if (target.kind === "db") skipped.add("building"); // 官方镜像无构建段
  return { skipped, na };
}

/** 六段的实时姿态：status 推导完成/失败，stage 定位当前段，skipped/na 优先覆盖 */
export function stepStates(
  stage: DeployStage,
  status: string,
  posture: { skipped: ReadonlySet<DeployStage>; na: ReadonlySet<DeployStage> },
): StepState[] {
  const idx = STAGES.indexOf(stage);
  return STAGES.map((s, i) => {
    if (posture.skipped.has(s)) return "skipped";
    if (posture.na.has(s)) return "na";
    if (status === "success") return "done";
    if (status === "failed") return i < idx ? "done" : i === idx ? "failed" : "pending";
    return i < idx ? "done" : i === idx ? "active" : "pending";
  });
}

const DOT: Record<StepState, string> = {
  done: "bg-tide-400",
  active: "bg-brass-500 animate-pulse",
  failed: "bg-signal-500",
  skipped: "border border-dashed border-neutral-600",
  na: "border border-harbor-800 opacity-40",
  pending: "border border-harbor-700",
};

const LINE: Record<StepState, string> = {
  done: "bg-tide-400/50",
  active: "bg-brass-500/40",
  failed: "bg-signal-500/40",
  skipped: "bg-harbor-800",
  na: "bg-harbor-800/50",
  pending: "bg-harbor-800",
};

export function PipelineSteps(props: { states: StepState[] }): JSX.Element {
  return (
    <span class="flex min-w-0 flex-1 items-center gap-0.5" aria-label="部署流水线">
      {props.states.map((s, i) => (
        <>
          <span class={`h-2 w-2 shrink-0 rounded-full ${DOT[s]}`} title={STAGE_LABEL[STAGES[i]!]} />
          {i < props.states.length - 1 ? <span class={`h-px min-w-1 flex-1 ${LINE[s]}`} /> : null}
        </>
      ))}
    </span>
  );
}
