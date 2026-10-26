/** @jsxImportSource solid-js */
/**
 * 嵌套卡片（flow 父子 subflow）：服务器卡 → app 卡（compose 项目）→ 服务卡；db 卡直属服务器卡。
 * 父子关系只表达归属与布局，边连在叶子上：db 卡 source handle，服务卡/app 卡 target handle。
 * 卡内全部交互元素带 data-nodrag，避免触发节点拖拽。
 */
import { For, Show, type JSX } from "solid-js";
import type { CardModel, DomainBadge, GroupModel, ServiceRow, TargetModel } from "../canvas.model";
import { api, canvasApi, unwrap } from "./api";
import { lens } from "./lens";
import { useServiceState, useTargetLive } from "./live";
import { emitRefresh, useUi } from "./ui";
import { confirmAction, toast } from "./feedback";
import { HandleView, Resizer, type FlowNodeBase } from "@elysiax/flow";

export type ServerFlowNode = FlowNodeBase & { type: "server"; data: { server: CardModel["server"] } };
export type AppFlowNode = FlowNodeBase & { type: "app"; data: { t: TargetModel } };
export type ServiceFlowNode = FlowNodeBase & { type: "service"; data: { t: TargetModel; s: ServiceRow } };
export type DbFlowNode = FlowNodeBase & { type: "db"; data: { t: TargetModel } };
export type GroupFlowNode = FlowNodeBase & { type: "group"; data: { g: GroupModel } };
export type CanvasFlowNode = ServerFlowNode | AppFlowNode | ServiceFlowNode | DbFlowNode | GroupFlowNode;

const STATUS_LABEL: Record<string, string> = {
  queued: "排队", building: "构建中", transferring: "传输中",
  deploying: "部署中", success: "运行中", failed: "失败",
};

export function Badge(props: { tone: "ok" | "warn" | "err" | "muted"; children: JSX.Element }) {
  return (
    <span class={`rounded px-1.5 py-0.5 text-[11px] font-medium mono ${
      props.tone === "ok" ? "bg-tide-400/10 text-tide-400"
      : props.tone === "warn" ? "bg-brass-500/15 text-brass-500"
      : props.tone === "err" ? "bg-signal-500/15 text-signal-500"
      : "bg-harbor-800 text-neutral-500"
    }`}>{props.children}</span>
  );
}

/** 部署状态徽章：订阅 SSE live store（accessor），status 变化只更新徽章，不重建 nodes */
const StatusBadge = (props: { targetId: number }) => {
  const live = useTargetLive(props.targetId);
  const tone = () => {
    const s = live().status;
    return !s ? "muted" : s === "success" ? "ok" : s === "failed" ? "err" : s === "queued" ? "muted" : "warn";
  };
  return (
    <Show when={live().status} fallback={<Badge tone="muted">未部署</Badge>}>
      {(s) => <Badge tone={tone()}>{STATUS_LABEL[s()] ?? s()}</Badge>}
    </Show>
  );
};

const btn = "nodrag rounded px-2 py-0.5 text-xs transition-colors";

const DomainLink = (props: { d: DomainBadge }) => (
  <a
    class={`nodrag block truncate text-[11px] mono transition-colors ${
      props.d.sslStatus === "active" ? "text-tide-400 hover:text-tide-300"
      : props.d.dnsStatus === "mismatch" ? "text-signal-500 hover:text-signal-400"
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
const StateDot = (props: { targetId: number; svcName: string }) => {
  const state = useServiceState(props.targetId, props.svcName);
  return (
    <span
      class={`h-2 w-2 shrink-0 rounded-full ${
        state() === "running" ? "bg-tide-400" : state() === "exited" ? "bg-signal-500" : "bg-neutral-600"
      }`}
      title={state() === "running" ? "运行中" : state() === "exited" ? "已停止" : "状态未知"}
    />
  );
};

/** Resizer 拉伸结束 → 持久化手动尺寸（refetch 后作自动收敛的下限） */
const persistServerSize = (nodeId: number, w: number, h: number) =>
  unwrap(canvasApi.nodes({ id: nodeId }).patch({ w: Math.round(w), h: Math.round(h) }));
const persistGroupSize = (groupId: number, w: number, h: number) =>
  unwrap(canvasApi.groups({ id: groupId }).patch({ w: Math.round(w), h: Math.round(h) }));
const persistTargetSize = (targetId: number, w: number, h: number) =>
  unwrap(api.targets({ id: targetId }).layout.patch({ w: Math.round(w), h: Math.round(h) }));

/** Railway 式体验：点部署即打开日志面板盯进度（抽屉内 1s 轮询到终态） */
async function deployTarget(ui: ReturnType<typeof useUi>, targetId: number) {
  await unwrap(api.targets({ id: targetId }).deploy.post());
  ui.open({ kind: "log", targetId });
}

async function removeTarget(t: { id: number; name: string; logical: boolean }) {
  const ok = await confirmAction({
    title: t.logical ? `移除逻辑库「${t.name}」？` : `移除部署目标「${t.name}」？`,
    body: t.logical ? "远端数据库保留，不会 DROP。" : "远端容器不动。",
    confirmLabel: "移除",
    danger: true,
  });
  if (!ok) return;
  try {
    await unwrap(api.targets({ id: t.id }).delete());
  } catch (e) {
    // 例如：实例下还有逻辑库，被阻止（409 + 错误文本）
    toast((e as Error).message, "err");
    return;
  }
  emitRefresh();
}

// ── 服务器卡（父）：只有标题；内容由子卡（app/db）撑大，尺寸在 board 同步时按子卡 bounds 算 ──
export const ServerNodeView = (props: { id: string; data: { server: CardModel["server"] }; selected: boolean; width?: number; height?: number }) => {
  const server = () => props.data.server;
  return (
    <div class="flex h-full w-full flex-col rounded-lg border border-harbor-600 bg-harbor-900/80 shadow-xl">
      <Resizer
        nodeId={props.id}
        visible={props.selected}
        minW={320}
        minH={160}
        width={props.width ?? 320}
        height={props.height ?? 160}
        onEnd={(w, h) => persistServerSize(server().id, w, h)}
      />
      <div class="flex cursor-move items-center justify-between rounded-t-lg border-b border-harbor-700 bg-harbor-800/80 px-3 py-1.5 select-none">
        <span class="text-sm font-medium text-neutral-100">🖥 {server().name}</span>
        {server().dockerStatus === "ok"
          ? <Badge tone="ok">docker {server().dockerVersion ?? ""}</Badge>
          : server().dockerStatus === "missing"
            ? <Badge tone="err">无 docker</Badge>
            : <Badge tone="muted">未检测</Badge>}
      </div>
      <div class="mono px-3 py-1 text-[11px] text-neutral-600">
        {server().user}@{server().host}:{server().port}
      </div>
    </div>
  );
};

// ── 服务分组（服务器卡内的命名容器）：虚线边界 + 标题；app/db 卡可拖入 ──
export const GroupNodeView = (props: { id: string; data: { g: GroupModel }; selected: boolean; width?: number; height?: number }) => (
  <div class="flex h-full w-full flex-col rounded-md border border-dashed border-harbor-500/70 bg-harbor-800/30">
    <Resizer
      nodeId={props.id}
      visible={props.selected}
      minW={220}
      minH={120}
      width={props.width ?? 220}
      height={props.height ?? 120}
      onEnd={(w, h) => persistGroupSize(props.data.g.id, w, h)}
    />
    <div class="cursor-move px-2.5 py-1 text-[11px] font-medium tracking-wide text-neutral-400 uppercase select-none">
      ▸ {props.data.g.name}
    </div>
  </div>
);

// ── app 卡（父，compose 项目）：头部 + 操作按钮；服务卡是它的子节点 ──
export const AppNodeView = (props: { id: string; data: { t: TargetModel }; selected: boolean; width?: number; height?: number }) => {
  const t = () => props.data.t;
  const live = useTargetLive(t().id);
  const ui = useUi();
  return (
    <div class="flex h-full w-full flex-col rounded-md border border-harbor-700 bg-harbor-950 shadow-lg">
      <Resizer
        nodeId={props.id}
        visible={props.selected}
        minW={320}
        minH={96}
        width={props.width ?? 320}
        height={props.height ?? 96}
        onEnd={(w, h) => persistTargetSize(t().id, w, h)}
      />
      <HandleView
        type="target"
        id={`tgt-${t().id}`}
        title="从数据库卡拖线到这里 = app 整体依赖"
      />
      <div class="flex items-center justify-between gap-2 px-2.5 pt-1.5">
        <span class="truncate text-xs font-medium text-neutral-100">📦 {t().name}</span>
        <div class="flex shrink-0 items-center gap-1">
          {/* 世界视图（无透镜）下标注项目归属 */}
          <Show when={lens() == null && t().projectName}><Badge tone="muted">{t().projectName}</Badge></Show>
          <For each={t().edges}>{(e) => <Badge tone="warn">⇠ {e.dbName}</Badge>}</For>
          <Show when={t().updateAvailable}><Badge tone="warn">有更新</Badge></Show>
          <StatusBadge targetId={t().id} />
        </div>
      </div>
      <div class="px-2.5">
        <For each={t().domains}>{(d) => <DomainLink d={d} />}</For>
      </div>
      <div class="mt-auto flex items-center gap-1 px-2.5 pt-1 pb-1.5" onClick={(e) => e.stopPropagation()}>
        <button class={`${btn} bg-harbor-800 text-neutral-300 hover:bg-harbor-700`}
          onClick={() => deployTarget(ui, t().id)}>
          {live().running ? "部署中…" : t().updateAvailable ? "更新部署" : "重新部署"}
        </button>
        <button class={`${btn} text-neutral-500 hover:text-neutral-200`}
          onClick={() => ui.open({ kind: "env", targetId: t().id })}>变量</button>
        <button class={`${btn} text-neutral-500 hover:text-neutral-200`}
          onClick={() => ui.open({ kind: "domains", targetId: t().id })}>域名</button>
        <button class={`${btn} text-neutral-500 hover:text-neutral-200`}
          onClick={() => ui.open({ kind: "log", targetId: t().id })}>日志</button>
        <button class={`${btn} text-neutral-600 hover:text-signal-500`}
          onClick={() => removeTarget(t())}>✕</button>
      </div>
    </div>
  );
};

// ── 服务卡（compose 声明式识别的叶子单元）：状态点 + 名称 + 端口 + 域名 ──
export const ServiceNodeView = (props: { data: { t: TargetModel; s: ServiceRow } }) => (
  <div
    class="flex h-full w-full cursor-pointer flex-col justify-center rounded border border-harbor-800 bg-harbor-900 px-2 py-1 transition-colors hover:border-harbor-600"
    title="点击查看服务详情"
  >
    <HandleView
      type="target"
      id={`tgt-${props.data.t.id}-${props.data.s.name}`}
      title="从数据库卡拖线到这里 = 该服务依赖"
    />
    <div class="flex items-center gap-1.5">
      <StateDot targetId={props.data.t.id} svcName={props.data.s.name} />
      <span class="mono truncate text-[11px] text-neutral-200">{props.data.s.name}</span>
      <Show when={props.data.s.port}>
        <span class="mono shrink-0 text-[11px] text-neutral-600">:{props.data.s.port}</span>
      </Show>
    </div>
    <For each={props.data.s.domains}>{(d) => <DomainLink d={d} />}</For>
  </div>
);

// ── 数据库卡（托管实例/逻辑库，直属服务器卡）──
export const DbNodeView = (props: { id: string; data: { t: TargetModel }; selected: boolean; width?: number; height?: number }) => {
  const t = () => props.data.t;
  const live = useTargetLive(t().id);
  const ui = useUi();
  return (
    <div class="flex h-full w-full flex-col rounded-md border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 shadow-lg">
      <Resizer
        nodeId={props.id}
        visible={props.selected}
        minW={320}
        minH={84}
        width={props.width ?? 320}
        height={props.height ?? 84}
        onEnd={(w, h) => persistTargetSize(t().id, w, h)}
      />
      <HandleView
        type="source"
        id={`src-${t().id}`}
        title="从此圆点拖线到服务卡/app 卡建依赖"
      />
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-xs font-medium text-neutral-100">
          {t().logical ? "⛁" : "🗄"} {t().name}
        </span>
        <div class="flex shrink-0 items-center gap-1">
          {/* 世界视图（无透镜）下标注项目归属 */}
          <Show when={lens() == null && t().projectName}><Badge tone="muted">{t().projectName}</Badge></Show>
          <StatusBadge targetId={t().id} />
        </div>
      </div>
      <div class="mt-auto flex items-center gap-1 pt-1" onClick={(e) => e.stopPropagation()}>
        <button class={`${btn} bg-harbor-800 text-neutral-300 hover:bg-harbor-700`}
          onClick={() => deployTarget(ui, t().id)}>
          {live().running ? "部署中…" : "重新部署"}
        </button>
        <Show when={t().url}>
          <button class={`${btn} text-tide-400 hover:text-tide-300`}
            onClick={() => navigator.clipboard.writeText(t().url!)}>连接串</button>
        </Show>
        <button class={`${btn} text-neutral-500 hover:text-neutral-200`}
          onClick={() => ui.open({ kind: "log", targetId: t().id })}>日志</button>
        <button class={`${btn} text-neutral-600 hover:text-signal-500`}
          onClick={() => removeTarget(t())}>✕</button>
      </div>
    </div>
  );
};
