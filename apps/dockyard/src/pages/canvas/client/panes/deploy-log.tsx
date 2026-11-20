/** @jsxImportSource solid-js */
/**
 * 画布抽屉/弹窗（Solid 版）：数据走 /api/canvas JSON，
 * 写操作 JSON 进出，错误内联回显；结构变更后 emitRefresh() 让画布重拉。
 *
 * React → Solid 转换要点：
 * - useState → createSignal，读取一律函数调用（envText() 等）
 * - useEffect → onMount（一次性加载/轮询）/ createEffect（跟随信号重拉）
 * - 行内编辑列表用 <Index> 而非 <For>：patchSvc 换对象引用时 <Index> 保 DOM，输入框不丢焦点
 * - React 版靠 key={repoUrl} 重挂载换 defaultValue，Solid 改为信号量受控输入
 * - onChange → 文本/数字用 onInput，select/checkbox/radio 用 onChange（原生语义）
 */
import {
  createEffect,
  createSignal,
  Index,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  splitProps,
  Switch,
} from "solid-js";
import type { JSX } from "solid-js";
import type {
  Deployment,
  DeploymentRow,
  DeployTarget,
} from "@/pages/deploy/deploy.socket";
import type { Domain } from "@/pages/edge/edge.socket";
import type { RepoBrief } from "@/pages/github/github.socket";
import type { DbConnection, DbRef, EnvEntry } from "@/pages/deploy/deploy.socket";
import type { DetectResult, DetectedService } from "@/pages/deploy/deploy.socket";
import type { DiscoveredContainer } from "../../canvas.model";
import copy from "copy-to-clipboard";
// env 文本函数从零依赖模块引（detect.ts 依赖链里的 dotenv 无法进浏览器包）
import { envMapToText, serviceEnvToText, textToEnvMap } from "@/shared/env-text";
import { api, deployPaths, unwrap } from "../infra/api";
import { ConsoleView } from "./console";
import { LogView } from "./log-view";
import { emitRefresh, useUi } from "../infra/ui";
import { confirmAction, toast } from "@/shared/solid-ui/feedback";
import { useDeployLog, useTargetLive } from "../infra/live";
import {
  mergeLiveRow,
  PipelineSteps,
  stagePosture,
  stepStates,
} from "./pipeline-steps";
// 移除目标的行为与卡面 ✕ 共用一份（成功才关抽屉，取消/失败保持原状）
import { removeTarget } from "../nodes";
// Panda recipe（panda/recipes.ts）：与 htmx 侧共享同一视觉契约，运行时只产 className
import {
  badge,
  button,
  drawer,
  field,
  modal,
} from "../../../../../styled-system/recipes";
import { cx } from "../../../../../styled-system/css";


import { Chip, Drawer, ErrorBanner, Field, Modal, Notice, Section, SubmitBtn } from "./shell";
// ── 部署日志（HTTP 回填 + SSE 增量，终态最后一次 HTTP 对齐防丢行）──

// 与服务端返回对齐：dep 缺部署记录时是 undefined（Eden 推断的真实形状）
interface LogData {
  target: DeployTarget;
  dep?: Deployment | null;
}

export function DeployLogModal(props: { targetId: number; dep?: number }) {
  const ui = useUi();
  const [data, setData] = createSignal<LogData | null>(null);
  const [backfill, setBackfill] = createSignal("尚未部署");
  /** 终态对齐后的权威全文（SSE 增量可能因重连/行数上限丢行，终态以 HTTP 为准） */
  const [finalText, setFinalText] = createSignal<string | null>(null);
  const live = useTargetLive(props.targetId);
  const liveLog = useDeployLog(props.targetId);

  const fetchBody = async () => {
    // 日志体是裸文本流（非 JSON），走原生 fetch + 路径助手
    const res = await fetch(
      `${deployPaths.targetsByIdLogBody(props.targetId)}${props.dep ? `?dep=${props.dep}` : ""}`,
    );
    return res.text();
  };

  onMount(async () => {
    try {
      const d = await unwrap(
        api
          .targets({ id: props.targetId })
          .log.get({ query: { dep: props.dep } }),
      );
      setData(d);
      const text = await fetchBody();
      setBackfill(text || "尚未部署");
    } catch {
      setBackfill("加载失败");
    }
  });

  // 终态对齐：live 状态进入 success/failed 时做最后一次 HTTP 全量回填。
  // 必须确认终态属于本抽屉看的那次 run：看历史日志时，别的 run 收尾不该触发回填
  createEffect(() => {
    const s = live().status;
    const depId = data()?.dep?.id;
    if (
      !depId ||
      finalText() !== null ||
      live().runId !== depId ||
      (s !== "success" && s !== "failed")
    )
      return;
    void (async () => {
      try {
        const head = await unwrap(
          api
            .targets({ id: props.targetId })
            .log.get({ query: { dep: props.dep } }),
        );
        setData(head);
        setFinalText((await fetchBody()) || "尚未部署");
      } catch {
        /* 对齐失败则维持 SSE/backfill 显示 */
      }
    })();
  });

  // 显示优先级：终态全文 > 当前 run 的 SSE 实时行 > 初始回填
  const logText = () => {
    const fin = finalText();
    if (fin !== null) return fin;
    const dep = data()?.dep;
    const lg = liveLog();
    if (dep && lg && lg.runId === dep.id && lg.lines.length)
      return lg.lines.join("\n");
    return backfill();
  };

  // 实时状态只在「属于正在看的那次 run」时才算数：看历史 run 的日志时，
  // 当前新 run 的 building 不能冒充成它的状态（服务端 status 帧带 runId）
  const depStatus = () => {
    const l = live();
    const depId = data()?.dep?.id;
    if (depId != null && l.runId !== depId) return data()?.dep?.status;
    return l.status ?? data()?.dep?.status;
  };
  return (
    <Modal
      title={`部署日志 — ${data()?.target.name ?? "…"}`}
      wide
      onClose={ui.close}
    >
      <Show when={depStatus()}>
        {(s) => (
          <div class="mb-2">
            <Chip
              tone={
                s() === "success" ? "ok" : s() === "failed" ? "err" : "muted"
              }
            >
              {s()}
            </Chip>
          </div>
        )}
      </Show>
      <LogView text={logText()} height="24rem" />
    </Modal>
  );
}

