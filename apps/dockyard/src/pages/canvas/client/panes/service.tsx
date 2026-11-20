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
// ── 服务抽屉（Railway Service View）──

import { DeploymentsTab } from "./service-tabs-deploy";
import { ServiceEnvTab, TargetEnvTab } from "./service-tabs-env";
import { HardwareTab, SourceTab, NetworkTab, BackupsTab } from "./service-tabs-infra";
import {
  type Metrics,
  type Mutate,
  type ServiceDrawerData,
  type ServiceTab,
  fmtAgo,
  fmtBytes,
} from "./service-shared";

/** 一次性资源快照（4s 轮询） */
const MetricsPanel = (props: { targetId: number; svc?: string }) => {
  const [stats, setStats] = createSignal<Metrics | null | undefined>(undefined);
  onMount(() => {

    const tick = async () => {
      try {
        const m = await unwrap(
          api
            .targets({ id: props.targetId })
            .service.metrics.get({ query: { svc: props.svc } }),
        );
        setStats(m);
      } catch {
        setStats(null);
      }
    };
    void tick();
    const timer = setInterval(tick, 4000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <Switch>
      <Match when={stats() === undefined}>
        <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">
          加载中…
        </div>
      </Match>
      <Match when={stats() === null}>
        <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">
          指标不可用（容器未运行或服务器离线）
        </div>
      </Match>
      <Match when={stats()!.state !== "running" ? stats() : null}>
        {(m) => (
          <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">
            容器状态:{m()!.state}
          </div>
        )}
      </Match>
      <Match when={stats()}>
        {(m) => (
          <div class="flex flex-col gap-3">
            <For
              each={[
                {
                  label: "CPU",
                  pct: Math.min(100, m()!.cpuPercent),
                  text: `${m()!.cpuPercent}%`,
                },
                {
                  label: "内存",
                  pct: m()!.memLimit
                    ? Math.min(100, (m()!.memUsage / m()!.memLimit) * 100)
                    : 0,
                  text: `${fmtBytes(m()!.memUsage)} / ${fmtBytes(m()!.memLimit)}`,
                },
              ]}
            >
              {(row) => (
                <div class="flex flex-col gap-1">
                  <div class="flex justify-between text-xs text-neutral-400">
                    <span>{row.label}</span>
                    <span class="mono">{row.text}</span>
                  </div>
                  <div class="h-1.5 overflow-hidden rounded bg-harbor-800">
                    <div
                      class={`h-full rounded ${row.pct > 85 ? "bg-signal-500" : "bg-tide-400"}`}
                      style={{ width: `${row.pct.toFixed(1)}%` }}
                    />
                  </div>
                </div>
              )}
            </For>
            <div class="flex justify-between text-xs text-neutral-400">
              <span>网络</span>
              <span class="mono">
                ↓ {fmtBytes(m()!.netRx)} · ↑ {fmtBytes(m()!.netTx)}
              </span>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  );
};

/** 服务日志（2s 轮询） */
const ServiceLogs = (props: { targetId: number; svc?: string }) => {
  const [text, setText] = createSignal("加载中…");
  onMount(() => {
    // SSH 拉 docker logs 可能超过一个轮询周期：禁止请求重叠，且只接受最后一次
    // 发出的请求结果，否则先发后到的旧快照会把新日志顶回去（表现为日志回跳/重复）
    let seq = 0;
    let inflight = false;
    const tick = async () => {
      if (inflight) return;
      inflight = true;
      const my = ++seq;
      try {
        const res = await fetch(
          `${deployPaths.targetsByIdServiceLogs(props.targetId)}${props.svc ? `?svc=${encodeURIComponent(props.svc)}` : ""}`,
        );
        if (!res.ok) {
          if (my === seq) setText(`日志获取失败：HTTP ${res.status}`);
          return;
        }
        const next = await res.text();
        if (my === seq) setText(next);
      } catch {
        /* 下轮再说 */
      } finally {
        inflight = false;
      }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    onCleanup(() => clearInterval(timer));
  });
  // 撑满抽屉里除操作行/历史列表外的剩余高度：不再用固定 40vh 把日志裁在抽屉底边外
  return <LogView text={text()} fill />;
};

export function ServiceDrawer(props: {
  targetId: number;
  svc?: string;
  initialTab?: string;
}) {
  const ui = useUi();
  const [tab, setTab] = createSignal<ServiceTab>(
    ([
      "deployments",
      "variables",
      "metrics",
      "console",
      "settings",
      "backups",
    ].includes(props.initialTab ?? "")
      ? props.initialTab
      : "deployments") as ServiceTab,
  );
  const [data, setData] = createSignal<ServiceDrawerData | null>(null);
  const [notice, setNotice] = createSignal<string>();
  const [error, setError] = createSignal<string>();

  // 请求世代：同一 tab 的 mount 与 SSE reload 也会并发，后到的旧快照不能顶掉新数据
  let gen = 0;
  const load = async () => {
    const my = ++gen;
    try {
      // 后端已改为全量返回（tab 只作回显，不再裁剪数据），前端一律传自身 tab 即可。
      const d = await unwrap(
        api
          .targets({ id: props.targetId })
          .service.get({ query: { tab: tab(), svc: props.svc } }),
      );
      // 世代守卫：切 tab / SSE 触发的并发 reload 里，只有最近一次请求的结果能写入
      if (my !== gen) return;
      setData(d);
    } catch (e) {
      // 世代守卫同样覆盖失败路径：切 tab 后旧请求的失败不能写进新 tab 的错误横幅
      if (my !== gen) return;
      setError((e as Error).message);
    }
  };
  // 跟随 tab 重拉（等价 React 的 [load] 依赖）；首挂也跑一次
  createEffect(() => {
    tab();
    setNotice(undefined);
    setError(undefined);
    void load();
  });

  /** 写操作统一出口：成功后提示 + 按需刷新画布/抽屉数据 */
  const mutate = async (
    fn: () => Promise<{ notice?: string }>,
    opts: { refreshBoard?: boolean; reload?: boolean } = {},
  ) => {
    setError(undefined);
    setNotice(undefined);
    try {
      const r = await fn();
      if (r.notice) setNotice(r.notice);
      if (opts.refreshBoard) emitRefresh();
      if (opts.reload !== false) await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const target = () => data()?.target;
  const isDbInstance = () => target()?.kind === "db" && !target()?.instanceOf;
  // Railway 式导航：Deployments / Variables / Metrics / Console / Settings（backups 仅 db）
  const tabs = (): { key: ServiceTab; label: string }[] => [
    { key: "deployments", label: "Deployments" },
    { key: "variables", label: "Variables" },
    { key: "metrics", label: "Metrics" },
    { key: "console", label: "Console" },
    { key: "settings", label: "Settings" },
    ...(isDbInstance() ? [{ key: "backups" as const, label: "Backups" }] : []),
  ];

  return (
    <Drawer
      wide
      title={
        props.svc
          ? `${target()?.name ?? "…"} / ${props.svc}`
          : (target()?.name ?? "…")
      }
      sub={props.svc ? "服务" : target()?.kind === "db" ? "数据库" : "应用"}
      onClose={ui.close}
    >
      {/* Deployments 页签用整高 flex：运行时日志吃满剩余空间；其他页签保持自然高度可滚动 */}
      <div
        class={cx(
          "flex flex-col gap-4",
          tab() === "deployments" ? "h-full min-h-0" : undefined,
        )}
      >
        <div class="flex gap-1 border-b border-harbor-800 pb-2">
          <For each={tabs()}>
            {(tb) => (
              <button
                onClick={() => setTab(tb.key)}
                class={`rounded px-2.5 py-1 text-xs transition-colors ${tab() === tb.key ? "bg-brass-500/15 font-medium text-brass-500" : "text-neutral-400 hover:bg-harbor-800 hover:text-neutral-200"}`}
              >
                {tb.label}
              </button>
            )}
          </For>
        </div>

        {notice() ? <Notice>{notice()}</Notice> : null}
        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        {!data() ? <div class="text-xs text-neutral-500">加载中…</div> : null}

        <Show when={data()}>
          {(d) => (
            <>
              <Show when={tab() === "deployments"}>
                <DeploymentsTab
                  data={d()}
                  svc={props.svc}
                  mutate={mutate}
                  reload={load}
                />
                <Section
                  title="运行时日志"
                  hint="实时流"
                  class="min-h-0 flex-1"
                >
                  <ServiceLogs targetId={props.targetId} svc={props.svc} />
                </Section>
              </Show>
              <Show when={tab() === "variables"}>
                {props.svc ? (
                  <ServiceEnvTab data={d()} svc={props.svc} mutate={mutate} />
                ) : (
                  <TargetEnvTab data={d()} mutate={mutate} />
                )}
              </Show>
              <Show when={tab() === "metrics"}>
                <MetricsPanel targetId={props.targetId} svc={props.svc} />
              </Show>
              <Show when={tab() === "console"}>
                <div class="flex flex-col gap-2">
                  <p class="text-xs text-neutral-500">
                    进入{props.svc ? `服务 ${props.svc}` : "容器"}
                    的交互式终端（docker exec）。关闭抽屉即断开。
                  </p>
                  <div class="h-[55vh] overflow-hidden rounded border border-harbor-800 bg-harbor-950 p-1">
                    <ConsoleView
                      targetId={props.targetId}
                      service={props.svc}
                    />
                  </div>
                </div>
              </Show>
              <Show when={tab() === "settings"}>
                <div class="flex flex-col gap-5">
                  <SourceTab data={d()} svc={props.svc} mutate={mutate} />
                  <Show when={props.svc}>
                    <HardwareTab data={d()} svc={props.svc!} mutate={mutate} />
                  </Show>
                  <NetworkTab data={d()} svc={props.svc} mutate={mutate} />
                  <Section title="危险区域">
                    <button
                      class={button({ variant: "danger", size: "sm" })}
                      onClick={() => {
                        void removeTarget(target()!).then((removed) => {
                          if (removed) ui.close();
                        });
                      }}
                    >
                      移除部署目标
                    </button>
                  </Section>
                </div>
              </Show>
              <Show when={tab() === "backups" && isDbInstance()}>
                <BackupsTab data={d()} mutate={mutate} />
              </Show>
            </>
          )}
        </Show>
      </div>
    </Drawer>
  );
}

