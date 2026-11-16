/** @jsxImportSource solid-js */
/**
 * 嵌套卡片（flow 父子 subflow）：服务器卡 → app 卡（compose 项目）→ 服务卡；db 卡直属服务器卡。
 * 父子关系只表达归属与布局，边连在叶子上：db 卡 source handle，服务卡/app 卡 target handle。
 * 卡内全部交互元素带 data-nodrag，避免触发节点拖拽。
 */
import { For, Show, type JSX } from "solid-js";
import type {
  CardModel,
  DiscoveredContainer,
  DomainBadge,
  GroupModel,
  ServiceRow,
  TargetModel,
} from "../canvas.model";
import { api, canvasApi, unwrap } from "./api";
import { lens } from "./lens";
import { useServiceState, useTargetLive } from "./live";
import { emitRefresh } from "./ui";
import { confirmAction, toast } from "./feedback";
import { HandleView, Resizer, type FlowNodeBase } from "@elysiax/flow";
// Panda recipe（panda/recipes.ts）：与 htmx 侧共享同一视觉契约，运行时只产 className
import { badge } from "../../../../styled-system/recipes";

export type ServerFlowNode = FlowNodeBase & {
  type: "server";
  data: { server: CardModel["server"] };
};
export type AppFlowNode = FlowNodeBase & {
  type: "app";
  data: { t: TargetModel };
};
export type ServiceFlowNode = FlowNodeBase & {
  type: "service";
  data: { t: TargetModel; s: ServiceRow };
};
export type DbFlowNode = FlowNodeBase & {
  type: "db";
  data: { t: TargetModel };
};
export type GroupFlowNode = FlowNodeBase & {
  type: "group";
  data: { g: GroupModel };
};
/** 发现容器卡：只读（不参与部署/拖拽持久化） */
export type DiscFlowNode = FlowNodeBase & {
  type: "container";
  data: { d: DiscoveredContainer };
};
export type CanvasFlowNode =
  | ServerFlowNode
  | AppFlowNode
  | ServiceFlowNode
  | DbFlowNode
  | GroupFlowNode
  | DiscFlowNode;

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

const DomainLink = (props: { d: DomainBadge }) => (
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
const StateDot = (props: { targetId: number; svcName: string }) => {
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
const StateDotRoot = (props: { targetId: number }) => {
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

/** Resizer 拉伸结束 → 持久化手动尺寸（refetch 后作自动收敛的下限）。
 *  服务端会按车道规则拒绝（422，例如本机卡拉宽压到中立带）：不能静默吞掉——
 *  提示原因并重拉 /board，把本地刚拉的尺寸回弹到库值。 */
const persistSize = (p: Promise<unknown>) =>
  void p.catch((e) => {
    toast((e as Error).message, "err");
    emitRefresh();
  });
const persistServerSize = (nodeId: number, w: number, h: number) =>
  persistSize(
    unwrap(
      canvasApi
        .nodes({ id: nodeId })
        .patch({ w: Math.round(w), h: Math.round(h) }),
    ),
  );
const persistGroupSize = (groupId: number, w: number, h: number) =>
  persistSize(
    unwrap(
      canvasApi
        .groups({ id: groupId })
        .patch({ w: Math.round(w), h: Math.round(h) }),
    ),
  );
const persistTargetSize = (targetId: number, w: number, h: number) =>
  persistSize(
    unwrap(
      api
        .targets({ id: targetId })
        .layout.patch({ w: Math.round(w), h: Math.round(h) }),
    ),
  );

/** 移除部署目标（卡面 ✕ 与抽屉危险区共用）：确认 → 删除 → 刷新画布。
 *  返回是否真的删除，调用方据此决定是否关闭抽屉（取消/失败时保持原状）。 */
export async function removeTarget(t: {
  id: number;
  name: string;
  logical?: boolean | null;
}): Promise<boolean> {
  const ok = await confirmAction({
    title: t.logical
      ? `移除逻辑库「${t.name}」？`
      : `移除部署目标「${t.name}」？`,
    body: t.logical ? "远端数据库保留，不会 DROP。" : "远端容器不动。",
    confirmLabel: "移除",
    danger: true,
  });
  if (!ok) return false;
  try {
    await unwrap(api.targets({ id: t.id }).delete());
  } catch (e) {
    // 例如：实例下还有逻辑库，被阻止（409 + 错误文本）
    toast((e as Error).message, "err");
    return false;
  }
  emitRefresh();
  return true;
}

// ── 服务器卡（父）：只有标题；内容由子卡（app/db）撑大，尺寸在 board 同步时按子卡 bounds 算 ──
export const ServerNodeView = (props: {
  id: string;
  data: { server: CardModel["server"] };
  selected: boolean;
  width?: number;
  height?: number;
}) => {
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
        <span class="text-sm font-medium text-neutral-100">
          🖥 {server().name}
        </span>
        {server().dockerStatus === "ok" ? (
          <Badge tone="ok">docker {server().dockerVersion ?? ""}</Badge>
        ) : server().dockerStatus === "missing" ? (
          <Badge tone="err">无 docker</Badge>
        ) : (
          <Badge tone="muted">未检测</Badge>
        )}
      </div>
      <div class="mono px-3 py-1 text-[11px] text-neutral-600">
        {server().local
          ? "本地进程直连"
          : `${server().user}@${server().host}:${server().port}`}
      </div>
    </div>
  );
};

// ── 发现容器卡（只读）：服务器上 docker 里跑着、但不归 dockyard 管的容器。
//    虚框 + 「发现」徽章，明确它与部署目标卡不同：没有部署/回滚/备份入口 ──
export const ContainerNodeView = (props: {
  id: string;
  data: { d: DiscoveredContainer };
  selected: boolean;
  width?: number;
  height?: number;
}) => {
  const d = () => props.data.d;
  return (
    <div
      class="flex h-full w-full cursor-pointer flex-col justify-center gap-1 rounded-lg border border-dashed border-harbor-600 bg-harbor-950/70 px-3 py-2 transition-colors hover:border-harbor-500"
      title="点击查看容器详情（只读）"
    >
      <div class="flex items-center gap-2">
        <span
          class={`h-2 w-2 shrink-0 rounded-full ${d().state === "running" ? "bg-tide-400" : "bg-signal-500"}`}
        />
        <span
          class="truncate text-sm font-medium text-neutral-200"
          title={d().name}
        >
          {d().name}
        </span>
        <span class="ml-auto flex shrink-0 items-center gap-1">
          {/* 世界视图（无透镜）下标注项目归属，与部署目标卡一致 */}
          <Show when={lens() == null && d().projectName}>
            <Badge tone="muted">{d().projectName}</Badge>
          </Show>
          <Badge tone="muted">发现</Badge>
        </span>
      </div>
      <div class="mono truncate text-[11px] text-neutral-500" title={d().image}>
        {d().image}
      </div>
      <div class="mono flex items-center justify-between gap-2 text-[11px] text-neutral-600">
        <span class="truncate">
          {d().service || d().composeProject || "独立容器"}
        </span>
        <Show when={d().ports}>
          <span class="shrink-0">{d().ports}</span>
        </Show>
      </div>
    </div>
  );
};

// ── 服务分组（服务器卡内的命名容器）：虚线边界 + 标题；app/db 卡可拖入 ──
export const GroupNodeView = (props: {
  id: string;
  data: { g: GroupModel };
  selected: boolean;
  width?: number;
  height?: number;
}) => (
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

// ── app 卡：一个 div 盒子。项目名 header（顶部）+ 服务名/域名纯粹流式行（不嵌套子节点）。
//    部署/变量/域名/日志/移除全部收进 Sidebar——数据库卡同样式，一个长方体 ──
export const AppNodeView = (props: {
  id: string;
  data: { t: TargetModel };
  selected: boolean;
  width?: number;
  height?: number;
}) => {
  const t = () => props.data.t;
  const live = useTargetLive(t().id);
  return (
    <div
      class="group relative flex h-full w-full flex-col overflow-hidden rounded-md border border-harbor-800 bg-harbor-950 transition-colors cursor-pointer hover:border-harbor-600"
      title="点击查看部署详情"
    >
      <Resizer
        nodeId={props.id}
        visible={props.selected}
        minW={320}
        minH={56}
        width={props.width ?? 320}
        height={props.height ?? 56}
        onEnd={(w, h) => persistTargetSize(t().id, w, h)}
      />
      <HandleView
        type="target"
        id={`tgt-${t().id}`}
        title="从数据库卡拖线到这里 = app 依赖"
      />
      {/* 顶部一行：状态点 + 项目名 + 右上角关闭 */}
      <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-harbor-800/60 px-2.5">
        <StateDotRoot targetId={t().id} />
        <span class="truncate text-xs font-medium text-neutral-100">
          📦 {t().name}
        </span>
        <Show when={live().running}>
          <span class="mono shrink-0 text-[10px] text-neutral-600">
            部署中…
          </span>
        </Show>
        <button
          class="nodrag ml-auto -mr-1 hidden rounded p-0.5 text-neutral-600 hover:text-signal-500 group-hover:block"
          aria-label="移除部署目标"
          onClick={(e) => {
            e.stopPropagation();
            removeTarget(t());
          }}
        >
          ✕
        </button>
      </div>
      {/* 服务列表：纯流式行（服务名 + 该服务绑定的域名），无边框子节点 */}
      <div class="flex min-h-0 flex-1 flex-col gap-1 px-2.5 py-1.5">
        <For each={t().services}>
          {(s) => (
            <div class="flex flex-col gap-0.5">
              <div class="flex items-center gap-1.5">
                <StateDot targetId={t().id} svcName={s.name} />
                <span class="mono truncate text-[11px] text-neutral-200">
                  {s.name}
                </span>
                <Show when={s.port}>
                  <span class="mono shrink-0 text-[11px] text-neutral-600">
                    :{s.port}
                  </span>
                </Show>
              </div>
              <For each={s.domains}>{(d) => <DomainLink d={d} />}</For>
            </div>
          )}
        </For>
        {/* app 级域名（无 serviceName 归属） */}
        <For each={t().domains}>{(d) => <DomainLink d={d} />}</For>
        <Show when={t().services.length === 0 && t().domains.length === 0}>
          <span class="text-[11px] text-neutral-600">无服务</span>
        </Show>
      </div>
    </div>
  );
};

// ── 服务卡（compose 声明式识别的叶子单元）：无边框纯内容行，嵌在 app 卡内——
//    消除「父框套子框」的多层边框嵌套，app 卡就是唯一的长方体 ──
export const ServiceNodeView = (props: {
  data: { t: TargetModel; s: ServiceRow };
}) => (
  <div
    class="flex h-full w-full cursor-pointer flex-col justify-center px-2 py-0.5 transition-colors hover:bg-harbor-800/40"
    title="点击查看服务详情"
  >
    <HandleView
      type="target"
      id={`tgt-${props.data.t.id}-${props.data.s.name}`}
      title="从数据库卡拖线到这里 = 该服务依赖"
    />
    <div class="flex items-center gap-1.5">
      <StateDot targetId={props.data.t.id} svcName={props.data.s.name} />
      <span class="mono truncate text-[11px] text-neutral-200">
        {props.data.s.name}
      </span>
      <Show when={props.data.s.port}>
        <span class="mono shrink-0 text-[11px] text-neutral-600">
          :{props.data.s.port}
        </span>
      </Show>
    </div>
    <For each={props.data.s.domains}>{(d) => <DomainLink d={d} />}</For>
  </div>
);

// ── 数据库卡（托管实例/逻辑库，直属服务器卡）：干净长方体，点击打开 Sidebar ──
export const DbNodeView = (props: {
  id: string;
  data: { t: TargetModel };
  selected: boolean;
  width?: number;
  height?: number;
}) => {
  const t = () => props.data.t;
  const live = useTargetLive(t().id);
  return (
    <div
      class="group relative flex h-full w-full flex-col justify-center gap-1 rounded-md border border-harbor-800 bg-harbor-950 px-2.5 py-1.5 transition-colors cursor-pointer hover:border-harbor-600"
      title="点击查看部署详情"
    >
      <Resizer
        nodeId={props.id}
        visible={props.selected}
        minW={320}
        minH={72}
        width={props.width ?? 320}
        height={props.height ?? 72}
        onEnd={(w, h) => persistTargetSize(t().id, w, h)}
      />
      <HandleView
        type="source"
        id={`src-${t().id}`}
        title="从此圆点拖线到服务卡/app 卡建依赖"
      />
      <div class="flex items-center gap-1.5">
        <StateDotRoot targetId={t().id} />
        <span class="truncate text-xs font-medium text-neutral-100">
          {t().logical ? "⛁" : "🗄"} {t().name}
        </span>
        <Show when={live().running}>
          <span class="mono shrink-0 text-[10px] text-neutral-600">
            部署中…
          </span>
        </Show>
        <button
          class="nodrag ml-auto -mr-1 hidden rounded p-0.5 text-neutral-600 hover:text-signal-500 group-hover:block"
          aria-label="移除部署目标"
          onClick={(e) => {
            e.stopPropagation();
            removeTarget(t());
          }}
        >
          ✕
        </button>
      </div>
      <div class="flex items-center gap-1.5">
        <Show when={t().url}>
          <span
            class="mono truncate text-[11px] text-tide-400"
            title={t().url!}
          >
            {t().url!.replace(/^.+?:\/\/|\/.+$/g, "")}
          </span>
        </Show>
        <span class="mono text-[11px] text-neutral-600">
          {t().logical ? "逻辑库" : "实例"}
        </span>
      </div>
    </div>
  );
};
