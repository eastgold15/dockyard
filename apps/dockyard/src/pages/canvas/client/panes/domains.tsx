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
} from "../../../deploy/deploy.socket";
import type { Domain } from "../../../edge/edge.socket";
import type { RepoBrief } from "../../../github/github.socket";
import type { DbConnection, DbRef, EnvEntry } from "../../../deploy/deploy.socket";
import type { DetectResult, DetectedService } from "../../../deploy/deploy.socket";
import type { DiscoveredContainer } from "../../canvas.model";
import copy from "copy-to-clipboard";
// env 文本函数从零依赖模块引（detect.ts 依赖链里的 dotenv 无法进浏览器包）
import { envMapToText, serviceEnvToText, textToEnvMap } from "../../../../shared/env-text";
import { api, deployPaths, unwrap } from "../infra/api";
import { ConsoleView } from "./console";
import { LogView } from "./log-view";
import { emitRefresh, useUi } from "../infra/ui";
import { confirmAction, toast } from "../../../../shared/solid-ui/feedback";
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
// ── 域名管理 ──

export const dnsChip = (d: Domain) =>
  d.dnsStatus === "ok" ? (
    <Chip tone="ok">DNS ✓</Chip>
  ) : d.dnsStatus === "mismatch" ? (
    <Chip tone="warn">DNS 未指向本机</Chip>
  ) : (
    <Chip>DNS 未检测</Chip>
  );
export const sslChip = (d: Domain) =>
  d.sslStatus === "active" ? (
    <Chip tone="ok">🔒 HTTPS</Chip>
  ) : d.sslStatus === "pending" ? (
    <Chip tone="warn">证书待签发</Chip>
  ) : d.sslStatus === "error" ? (
    <Chip tone="err">证书异常</Chip>
  ) : (
    <Chip>无证书</Chip>
  );

interface DomainsData {
  target: DeployTarget;
  domains: Domain[];
}

export function DomainsModal(props: { targetId: number }) {
  const ui = useUi();
  const [data, setData] = createSignal<DomainsData | null>(null);
  const [error, setError] = createSignal<string>();

  const load = () => {
    unwrap(api.targets({ id: props.targetId }).domains.get())
      .then(setData)
      .catch((e) => setError((e as Error).message));
  };
  onMount(load);

  const remove = async (d: Domain) => {
    if (
      !(await confirmAction({
        title: `解绑 ${d.hostname}？`,
        confirmLabel: "解绑",
        danger: true,
      }))
    )
      return;
    try {
      await unwrap(api.domains({ id: d.id }).delete());
      emitRefresh();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submit = async (
    e: SubmitEvent & { currentTarget: HTMLFormElement },
  ) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await unwrap(
        api.targets({ id: props.targetId }).domains.post({
          hostname: String(fd.get("hostname") ?? ""),
          targetPort: Number(fd.get("targetPort")),
        }),
      );
      e.currentTarget.reset();
      emitRefresh();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={`域名 — ${data()?.target.name ?? "…"}`} onClose={ui.close}>
      <div class="flex flex-col gap-3">
        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        <Show when={data() && data()!.domains.length === 0}>
          <div class="text-xs text-neutral-500">
            还没有绑定域名。绑定后自动反代并签发 HTTPS 证书。
          </div>
        </Show>
        <For each={data()?.domains ?? []}>
          {(d) => (
            <div class="flex items-center justify-between gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2">
              <div class="flex flex-col gap-1">
                <a
                  class="text-xs font-medium text-tide-400 hover:opacity-80 mono"
                  href={`https://${d.hostname}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {d.hostname}
                </a>
                <span class="text-[11px] text-neutral-500 mono">
                  → :{d.targetPort}
                  {d.serviceName ? `（${d.serviceName}）` : ""}
                </span>
              </div>
              <div class="flex items-center gap-1.5">
                {dnsChip(d)}
                {sslChip(d)}
                <button
                  class={button({ variant: "danger", size: "sm" })}
                  onClick={() => void remove(d)}
                >
                  ✕
                </button>
              </div>
            </div>
          )}
        </For>
        <form class="flex items-end gap-2" onSubmit={submit}>
          <label class="flex flex-1 flex-col gap-0.5">
            <span class="text-xs text-neutral-500">域名</span>
            <input
              class={field()}
              type="text"
              name="hostname"
              placeholder="app.example.com"
              required
            />
          </label>
          <label class="flex w-24 flex-col gap-0.5">
            <span class="text-xs text-neutral-500">端口</span>
            <input class={field()} type="number" name="targetPort" required />
          </label>
          <button
            type="submit"
            class={button({ variant: "primary", size: "md" })}
          >
            绑定
          </button>
        </form>
        <div class="text-xs text-neutral-500">
          域名 A 记录指向服务器 IP 后，证书会自动签发。
        </div>
      </div>
    </Modal>
  );
}

