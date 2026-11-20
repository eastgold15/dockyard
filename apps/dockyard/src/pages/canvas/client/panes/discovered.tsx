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
// ── 发现容器详情（只读）：docker 里跑着、但 dockyard 没纳管的容器 ──
// 数据来自 /board 快照（点卡片时已在本机），不额外请求；没有部署/回滚/备份入口。

const STATE_LABEL: Record<string, string> = {
  running: "运行中",
  exited: "已停止",
  created: "已创建",
  restarting: "重启中",
  paused: "已暂停",
  dead: "已失效",
  unknown: "未知",
};

export function DiscoveredModal(props: { d: DiscoveredContainer }) {
  const ui = useUi();
  const d = () => props.d;
  const [copied, setCopied] = createSignal(false);
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(d().id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("复制失败，请手动选中容器 ID", "err");
    }
  };

  const row = (label: string, value: JSX.Element) => (
    <>
      <span class="text-xs text-neutral-500">{label}</span>
      <span class="min-w-0 text-neutral-300">{value}</span>
    </>
  );

  return (
    <Modal title={`容器详情 — ${d().name}`} onClose={ui.close}>
      <div class="flex flex-col gap-5">
        <Notice>
          发现容器未纳入 dockyard
          管理：这里只做只读呈现，不提供部署、回滚或备份。要纳管请走「部署本仓库
          / 添加数据库」。
        </Notice>

        <Section title="容器">
          <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-xs">
            {row(
              "状态",
              d().state === "running" ? (
                <Chip tone="ok">{STATE_LABEL.running}</Chip>
              ) : (
                <Chip tone="warn">{STATE_LABEL[d().state] ?? d().state}</Chip>
              ),
            )}
            {row(
              "镜像",
              <span class="mono break-all text-neutral-200">
                {d().image || "—"}
              </span>,
            )}
            {row(
              "容器 ID",
              <span class="flex items-center gap-2">
                <code class="mono select-all text-neutral-400">{d().id}</code>
                <button
                  class={cx(
                    button({ variant: "ghost", size: "sm" }),
                    "shrink-0",
                  )}
                  onClick={() => void copyId()}
                >
                  {copied() ? "已复制" : "复制"}
                </button>
              </span>,
            )}
          </div>
        </Section>

        <Section title="compose">
          <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-xs">
            {row("服务", <span class="mono">{d().service || "—"}</span>)}
            {row(
              "项目名",
              <span class="mono">{d().composeProject || "—"}</span>,
            )}
          </div>
        </Section>

        <Section title="端口" hint="公网映射 → 容器端口">
          <span class="mono text-xs text-neutral-300">
            {d().ports || "无端口映射"}
          </span>
        </Section>

        <Section title="项目归属">
          <span class="text-xs text-neutral-300">
            {d().projectName
              ? `按 compose working_dir 归属到 ${d().projectName}`
              : "未匹配到 dockyard 项目（只在世界视图显示）"}
          </span>
        </Section>
      </div>
    </Modal>
  );
}
