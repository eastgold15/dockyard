/** @jsxImportSource solid-js */
/**
 * 嵌套卡片（flow 父子 subflow）：服务器卡 → app 卡（compose 项目）→ 服务卡；db 卡直属服务器卡。
 * 父子关系只表达归属与布局，边连在叶子上：db 卡 source handle，服务卡/app 卡 target handle。
 * 卡内全部交互元素带 data-nodrag，避免触发节点拖拽。
 */
import { For, Show, type JSX } from "solid-js";
import type { CardModel, DiscoveredContainer, DomainBadge, GroupModel, ServiceRow, TargetModel } from "../canvas.model";
import { api, canvasApi, unwrap } from "./api";
import { lens } from "./lens";
import { useServiceState, useTargetLive } from "./live";
import { emitRefresh, useUi } from "./ui";
import { confirmAction, toast } from "./feedback";
import { HandleView, Resizer, type FlowNodeBase } from "@elysiax/flow";
// Panda recipe（panda/recipes.ts）：与 htmx 侧共享同一视觉契约，运行时只产 className
import { badge, button } from "../../../../styled-system/recipes";
import { cx } from "../../../../styled-system/css";

export type ServerFlowNode = FlowNodeBase & { type: "server"; data: { server: CardModel["server"] } };
export type AppFlowNode = FlowNodeBase & { type: "app"; data: { t: TargetModel } };
export type ServiceFlowNode = FlowNodeBase & { type: "service"; data: { t: TargetModel; s: ServiceRow } };
export type DbFlowNode = FlowNodeBase & { type: "db"; data: { t: TargetModel } };
export type GroupFlowNode = FlowNodeBase & { type: "group"; data: { g: GroupModel } };
/** 发现容器卡：只读（不参与部署/拖拽持久化） */
export type DiscFlowNode = FlowNodeBase & { type: "container"; data: { d: DiscoveredContainer } };
export type CanvasFlowNode = ServerFlowNode | AppFlowNode | ServiceFlowNode | DbFlowNode | GroupFlowNode | DiscFlowNode;

const STATUS_LABEL: Record<string, string> = {
  queued: "排队", building: "构建中", transferring: "传输中",
  deploying: "部署中", success: "运行中", failed: "失败",
};

export function Badge(props: { tone: "ok" | "warn" | "err" | "muted"; children: JSX.Element }) {
  return (
    <span class={badge({ tone: props.tone })}>{props.children}</span>
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

// 卡内紧凑按钮：全部走共享 button recipe（sm 32px / 12px），只补 nodrag 防止触发节点拖拽；
// extra 用于个别按钮的语义着色覆盖（如「连接串」保留 Tide 强调色）
const cardBtn = (v: Parameters<typeof button>[0] | undefined, extra?: string) => cx(button(v), "nodrag", extra);

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

/** Resizer 拉伸结束 → 持久化手动尺寸（refetch 后作自动收敛的下限）。
 *  服务端会按车道规则拒绝（422，例如本机卡拉宽压到中立带）：不能静默吞掉——
 *  提示原因并重拉 /board，把本地刚拉的尺寸回弹到库值。 */
const persistSize = (p: Promise<unknown>) =>
  void p.catch((e) => {
    toast((e as Error).message, "err");
    emitRefresh();
  });
const persistServerSize = (nodeId: number, w: number, h: number) =>
  persistSize(unwrap(canvasApi.nodes({ id: nodeId }).patch({ w: Math.round(w), h: Math.round(h) })));
const persistGroupSize = (groupId: number, w: number, h: number) =>
  persistSize(unwrap(canvasApi.groups({ id: groupId }).patch({ w: Math.round(w), h: Math.round(h) })));
const persistTargetSize = (targetId: number, w: number, h: number) =>
  persistSize(unwrap(api.targets({ id: targetId }).layout.patch({ w: Math.round(w), h: Math.round(h) })));

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
        {server().local ? "本地进程直连" : `${server().user}@${server().host}:${server().port}`}
      </div>
    </div>
  );
};

// ── 发现容器卡（只读）：服务器上 docker 里跑着、但不归 dockyard 管的容器。
//    虚框 + 「发现」徽章，明确它与部署目标卡不同：没有部署/回滚/备份入口 ──
export const ContainerNodeView = (props: { id: string; data: { d: DiscoveredContainer }; selected: boolean; width?: number; height?: number }) => {
  const d = () => props.data.d;
  return (
    <div
      class="flex h-full w-full cursor-pointer flex-col justify-center gap-1 rounded-lg border border-dashed border-harbor-600 bg-harbor-950/70 px-3 py-2 transition-colors hover:border-harbor-500"
      title="点击查看容器详情（只读）"
    >
      <div class="flex items-center gap-2">
        <span class={`h-2 w-2 shrink-0 rounded-full ${d().state === "running" ? "bg-tide-400" : "bg-signal-500"}`} />
        <span class="truncate text-sm font-medium text-neutral-200" title={d().name}>{d().name}</span>
        <span class="ml-auto flex shrink-0 items-center gap-1">
          {/* 世界视图（无透镜）下标注项目归属，与部署目标卡一致 */}
          <Show when={lens() == null && d().projectName}><Badge tone="muted">{d().projectName}</Badge></Show>
          <Badge tone="muted">发现</Badge>
        </span>
      </div>
      <div class="mono truncate text-[11px] text-neutral-500" title={d().image}>{d().image}</div>
      <div class="mono flex items-center justify-between gap-2 text-[11px] text-neutral-600">
        <span class="truncate">{d().service || d().composeProject || "独立容器"}</span>
        <Show when={d().ports}><span class="shrink-0">{d().ports}</span></Show>
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
        {/* 部署是本卡的唯一主操作：primary 实底黄铜；其余次按钮用 ghost */}
        <button class={cardBtn({ variant: "primary", size: "sm" })}
          onClick={() => deployTarget(ui, t().id)}>
          {live().running ? "部署中…" : t().updateAvailable ? "更新部署" : "重新部署"}
        </button>
        <button class={cardBtn({ variant: "ghost", size: "sm" })}
          onClick={() => ui.open({ kind: "env", targetId: t().id })}>变量</button>
        <button class={cardBtn({ variant: "ghost", size: "sm" })}
          onClick={() => ui.open({ kind: "domains", targetId: t().id })}>域名</button>
        <button class={cardBtn({ variant: "ghost", size: "sm" })}
          onClick={() => ui.open({ kind: "log", targetId: t().id })}>日志</button>
        {/* 移除是危险操作，但本行主操作是部署：✕ 保持弱化（ghost 外壳 + 悬停才亮 Signal），避免与主按钮抢注意力 */}
        <button class={cardBtn({ variant: "ghost", size: "sm" }, "text-neutral-500 hover:text-signal-500")} aria-label="移除部署目标"
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
        {/* 部署是本卡的唯一主操作：primary 实底黄铜；其余次按钮用 ghost */}
        <button class={cardBtn({ variant: "primary", size: "sm" })}
          onClick={() => deployTarget(ui, t().id)}>
          {live().running ? "部署中…" : "重新部署"}
        </button>
        <Show when={t().url}>
          {/* 连接串复制是成功/就绪语义的辅助操作：ghost 外壳 + Tide 文字强调色 */}
          <button class={cardBtn({ variant: "ghost", size: "sm" }, "text-tide-400 hover:text-tide-300")}
            onClick={() => navigator.clipboard.writeText(t().url!)}>连接串</button>
        </Show>
        <button class={cardBtn({ variant: "ghost", size: "sm" })}
          onClick={() => ui.open({ kind: "log", targetId: t().id })}>日志</button>
        {/* 移除是危险操作，但本行主操作是部署：✕ 保持弱化（ghost 外壳 + 悬停才亮 Signal），避免与主按钮抢注意力 */}
        <button class={cardBtn({ variant: "ghost", size: "sm" }, "text-neutral-500 hover:text-signal-500")} aria-label="移除部署目标"
          onClick={() => removeTarget(t())}>✕</button>
      </div>
    </div>
  );
};
