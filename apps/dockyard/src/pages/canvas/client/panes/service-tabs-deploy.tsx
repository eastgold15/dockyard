/** @jsxImportSource @solidjs/web */
/**
 * 画布抽屉/弹窗（Solid 版）：数据走 /api/canvas JSON，
 * 写操作 JSON 进出，错误内联回显；结构变更后 emitRefresh() 让画布重拉。
 *
 * React → Solid 转换要点：
 * - useState → createSignal，读取一律函数调用（envText() 等）
 * - useEffect → onSettled（一次性加载/轮询）/ createEffect（跟随信号重拉）
 * - 行内编辑列表用 <For>（原 <Index>）：patchSvc 换对象引用时保 DOM，输入框不丢焦点
 * - React 版靠 key={repoUrl} 重挂载换 defaultValue，Solid 改为信号量受控输入
 * - onChange → 文本/数字用 onInput，select/checkbox/radio 用 onChange（原生语义）
 */
import {
  createEffect,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";;;
import type { JSX } from "@solidjs/web";
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
// ── 服务抽屉（Railway Service View）──

import type { Mutate, ServiceDrawerData } from "./service-shared";
import { fmtAgo } from "./service-shared";
export function DeploymentsTab(props: {
  data: ServiceDrawerData;
  svc?: string;
  mutate: Mutate;
  reload: () => Promise<void>;
}) {
  const ui = useUi();
  const t = () => props.data.target;
  // 实时通道：进行中 run 的步骤条跟 SSE 脉冲，历史行回落到库值
  const live = useTargetLive(t().id);
  // 列表对齐的两个时机（effect 只依赖 live，reload 不回写 live，不会自激）：
  // 1) runId 换主 = 新 run 开播：库里还没有这一行，不拉列表步骤条就没有宿主行；
  // 2) 终态：SSE 只带粗状态，库里的 stage/rollbackable/finishedAt 需要对齐。
  // 用 runId 而不是 running 判「新 run」——running 在整段执行中都为 true，
  // 拿它当条件会变成每次 status 迁移都重拉一次列表。
  let seenRunId: number | null = null;
  let prevStatus: string | null = null;
  // Solid 2 两段式 effect：compute 段读 live 的 status/runId，effect 段决定要不要重拉
  createEffect(
    () => ({ s: live().status, id: live().runId }),
    ({ s, id }) => {
      if (id != null && id !== seenRunId) {
        seenRunId = id;
        prevStatus = s;
        void props.reload();
        return;
      }
      const terminal = s === "success" || s === "failed";
      const wasTerminal = prevStatus === "success" || prevStatus === "failed";
      prevStatus = s;
      // 只认「非终态 → 终态」这一跳：终态之后服务端还会推一条 running:false，
      // store 对象换新会让 effect 再跑一次，按值判断会把同一次收尾重拉两遍
      if (terminal && !wasTerminal) void props.reload();
    },
  );
  return (
    <>
      <div class="flex shrink-0 items-center gap-2">
        <button
          class={button({ variant: "primary", size: "sm" })}
          onClick={async () => {
            await unwrap(api.targets({ id: t().id }).deploy.post());
            // 部署是后台任务：先拉一次让 queued 行出现在列表，后续段位由 SSE 驱动
            await props.reload();
            ui.open({ kind: "log", targetId: t().id });
          }}
        >
          重新部署
        </button>
        <button
          class={button({ variant: "ghost", size: "sm" })}
          onClick={() =>
            void props.mutate(
              () =>
                unwrap(
                  api
                    .targets({ id: t().id })
                    .service.restart.post({ svc: props.svc }),
                ),
              { reload: false },
            )
          }
        >
          重启{props.svc ? "服务" : "容器"}
        </button>
        {/* 本地导入 app 的显式通道：构建产物推到远端（跨区移动的门票），不起容器。
            判据用服务端给的 sourceType：local 项目也可能带 repoUrl（克隆到本地后导入），
            按「没有 repoUrl」判会把这类 app 的传输按钮藏掉，跨区移动彻底死锁 */}
        <Show when={t().kind === "app" && props.data.sourceType === "local"}>
          <button
            class={button({ variant: "ghost", size: "sm" })}
            title={
              t().artifactShipped
                ? "产物已传输过（可再传更新）"
                : "跨区移动前必须先传输产物"
            }
            onClick={async () => {
              await unwrap(api.targets({ id: t().id }).ship.post());
              await props.reload();
              ui.open({ kind: "log", targetId: t().id });
            }}
          >
            传输产物{t().artifactShipped ? " ✓" : ""}
          </button>
        </Show>
        {/* 部署策略三态：manual 不轮询 / notify 只亮徽章 / auto 检出更新即部署 */}
        <select
          class={cx(field(), "ml-auto h-8 w-auto text-xs")}
          value={t().deployPolicy}
          title="检出更新时：手动部署=不轮询；仅提醒=亮「有更新」徽章；自动部署=立即触发"
          onChange={(e) =>
            void props.mutate(
              () =>
                unwrap(
                  api
                    .targets({ id: t().id })
                    .policy.post({
                      policy: e.currentTarget.value as
                        "manual" | "notify" | "auto",
                    }),
                ),
              { reload: false },
            )
          }
        >
          <option value="manual">手动部署</option>
          <option value="notify">仅提醒</option>
          <option value="auto">自动部署</option>
        </select>
      </div>
      {/* 历史列表自带上限与滚动：不让长历史把下面的运行时日志顶出抽屉可视区 */}
      <div class="flex max-h-64 shrink-0 flex-col overflow-y-auto">
        <Show when={(props.data.deployments ?? []).length === 0}>
          <div class="py-4 text-center text-xs text-neutral-600">
            还没有部署记录
          </div>
        </Show>
        <For each={props.data.deployments ?? []}>
          {(d) => {
            // 只有「在跑的那一行」吃实时值：历史行若也读 live，会显示成当前 run 的状态/段位
            const run = () => mergeLiveRow(d, live());
            const runStatus = () => run().status;
            const runStage = () => run().stage;
            return (
              <div class="flex items-center gap-3 border-b border-harbor-800/60 py-2 text-xs">
                <Chip
                  tone={
                    runStatus() === "success"
                      ? "ok"
                      : runStatus() === "failed"
                        ? "err"
                        : "muted"
                  }
                >
                  {runStatus()}
                </Chip>
                <span class="text-neutral-500">#{d.id}</span>
                {/* 触发来源：手动/自动/回滚/仅传输（回滚带血缘号） */}
                <Show when={d.trigger && d.trigger !== "ui"}>
                  <span class="rounded border border-harbor-700 px-1 text-[10px] text-neutral-500">
                    {d.trigger === "rollback"
                      ? `回滚←#${d.rollbackOf}`
                      : d.trigger === "ship"
                        ? "仅传输"
                        : "自动"}
                  </span>
                </Show>
                {/* 六阶段迷你步骤条：stage=null（旁路/存量）降级不显示。
                  用合并后的 runStage 判降级——新 run 的库行 stage 还是 null，实时值已到 */}
                <Show
                  when={stagePosture(
                    { ...t(), sourceType: props.data.sourceType },
                    { trigger: d.trigger, stage: runStage() },
                  )}
                >
                  {(posture) => (
                    <PipelineSteps
                      states={stepStates(runStage()!, runStatus(), posture())}
                    />
                  )}
                </Show>
                <span class="text-neutral-400">{fmtAgo(d.startedAt)}</span>
                {d.finishedAt ? (
                  <span class="mono text-neutral-600">
                    {Math.round(
                      (new Date(d.finishedAt).getTime() -
                        new Date(d.startedAt).getTime()) /
                        1000,
                    )}
                    s
                  </span>
                ) : null}
                <div class="ml-auto flex items-center gap-2">
                  {/* 回滚仅对有产物的成功 run 开放（rollbackable 由历史联查 deploy_artifacts 透出）；旧 run 无产物，置灰 */}
                  <button
                    class={button({ variant: "danger", size: "sm" })}
                    disabled={!d.rollbackable}
                    title={
                      d.rollbackable
                        ? `回滚到 run #${d.id}`
                        : "无快照，无法回滚"
                    }
                    onClick={() => {
                      void (async () => {
                        const ok = await confirmAction({
                          title: `回滚到 run #${d.id}？`,
                          body: `提交 ${d.commitSha ?? "无 sha"}——容器将切回当时的镜像与配置。`,
                          confirmLabel: "回滚",
                          danger: true,
                        });
                        if (!ok) return;
                        await unwrap(
                          api
                            .targets({ id: t().id })
                            .rollback.post({ runId: d.id }),
                        );
                        await props.reload();
                        ui.open({ kind: "log", targetId: t().id });
                      })();
                    }}
                  >
                    回滚
                  </button>
                  <button
                    class={button({ variant: "ghost", size: "sm" })}
                    onClick={() =>
                      ui.open({ kind: "log", targetId: t().id, dep: d.id })
                    }
                  >
                    日志
                  </button>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </>
  );
}

