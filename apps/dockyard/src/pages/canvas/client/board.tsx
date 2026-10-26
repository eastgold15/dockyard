/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import type { BoardModel, CardModel, TargetModel } from "../canvas.model";
import {
  AppNodeView, DbNodeView, GroupNodeView, ServerNodeView, ServiceNodeView,
  type CanvasFlowNode,
} from "./nodes";
import { api, canvasApi, unwrap } from "./api";
import { emptyLive, LiveContext, LOG_TAIL_LIMIT, type LiveState } from "./live";
import { useUi } from "./ui";
import { confirmAction, promptAction, toast } from "./feedback";
import { clampCardX, laneRect } from "../zones";
import { FlowView, type ConnectResult, type FlowEdge, type NodeViewProps } from "@elysiax/flow";

/** 全局 SSE 端点（世界地图：无 projectId 路径段；routes.gen 由 dev server 再生成，这里用字面量） */
const EVENTS_URL = "/api/canvas/events";

const nodeViews = {
  server: ServerNodeView, app: AppNodeView, service: ServiceNodeView,
  db: DbNodeView, group: GroupNodeView,
} as unknown as Record<string, (p: NodeViewProps<never>) => Element>;

// 依赖边样式（虚线黄铜 + 箭头）
const DEP_EDGE = {
  stroke: "#d9a441", strokeOpacity: 0.6, strokeWidth: 1.5,
  strokeDasharray: "5 3", arrowColor: "#d9a441",
} as const;

// ── 布局常量（父卡显式尺寸由子卡 bounds 算，估算值与 nodes.tsx 的 Tailwind 类对应）──
const CHILD_W = 320;      // app/db 卡宽
const SVC_H = 34, SVC_GAP = 8, SVC_TOP = 58; // 服务卡在 app 卡内：x=14，y 从 SVC_TOP 起按实际高度累加
const SVC_DOMAIN_H = 16;  // 服务卡里每行域名的高度
const APP_MIN_H = 96;     // 无服务清单的 app 卡高
const APP_TAIL_H = 46;    // 服务块之后的按钮区
const DB_H = 84;
const PAD = 14, HEADER_H = 56, GAP = 12; // 服务器卡：内边距/标题/子卡间距
const SVC_W = CHILD_W - 28;
const GROUP_HEADER_H = 30;   // 分组卡标题高度
const GROUP_MIN_W = 220, GROUP_MIN_H = 120;

const srvId = (nodeId: number) => `srv-${nodeId}`;
const appId = (targetId: number) => `app-${targetId}`;
const svcId = (targetId: number, name: string) => `svc-${targetId}-${name}`;
const dbId = (targetId: number) => `db-${targetId}`;
const grpId = (groupId: number) => `grp-${groupId}`;

/** 服务卡高 = 名称行 + 域名行数 */
const svcHeight = (s: TargetModel["services"][number]) => SVC_H + s.domains.length * SVC_DOMAIN_H;

/** app 卡内容高 = 服务卡实际高度累加 + 按钮区 */
const appContentBottom = (t: TargetModel) =>
  t.services.reduce((y, s) => y + svcHeight(s) + SVC_GAP, SVC_TOP);

/**
 * 拖拽时父卡随子卡撑大（grow-only，只长不缩避免抖动；结构 refetch 时由 deriveNodes 精确收敛）。
 * resizingIds：Resizer 拖拽中的节点必须跳过 clamp 和 grow——否则 grow-only 把用户缩小的尺寸
 * 立刻 max 回去，与 Resizer 互相覆盖抖动。
 */
function fitParents(ns: CanvasFlowNode[], resizingIds?: ReadonlySet<string>): CanvasFlowNode[] {
  // 钳制子卡不越出父卡内容区（左/上）——服务卡/app 卡不能拖到标题栏或负坐标
  const clamped = ns.map((n) => {
    if (resizingIds?.has(n.id)) return n;
    if (n.type === "service") {
      const x = Math.max(PAD, n.position.x), y = Math.max(SVC_TOP, n.position.y);
      return x === n.position.x && y === n.position.y ? n : { ...n, position: { x, y } };
    }
    if ((n.type === "app" || n.type === "db") && n.parentId) {
      const x = Math.max(PAD, n.position.x), y = Math.max(HEADER_H, n.position.y);
      return x === n.position.x && y === n.position.y ? n : { ...n, position: { x, y } };
    }
    return n;
  });
  ns = clamped;
  const kidsOf = new Map<string, CanvasFlowNode[]>();
  for (const n of ns) {
    if (!n.parentId) continue;
    const arr = kidsOf.get(n.parentId) ?? [];
    arr.push(n);
    kidsOf.set(n.parentId, arr);
  }
  const grow = (n: CanvasFlowNode, minW: number, minH: number, padX: number, padBottom: number): CanvasFlowNode => {
    if (resizingIds?.has(n.id)) return n; // Resizer 拖拽中：尊重其精确尺寸
    const kids = kidsOf.get(n.id);
    if (!kids?.length) return n;
    const w = Math.max(n.width ?? 0, minW, ...kids.map((k) => k.position.x + (k.width ?? 0) + padX));
    const h = Math.max(n.height ?? 0, minH, ...kids.map((k) => k.position.y + (k.height ?? 0) + padBottom));
    return w === n.width && h === n.height ? n : { ...n, width: w, height: h };
  };
  return ns.map((n) =>
    n.type === "app" ? grow(n, CHILD_W, APP_MIN_H, PAD, APP_TAIL_H)
    : n.type === "group" ? grow(n, GROUP_MIN_W, GROUP_MIN_H, PAD, PAD)
    : n.type === "server" ? grow(n, PAD + CHILD_W + PAD, HEADER_H + APP_MIN_H + PAD, PAD, PAD)
    : n
  );
}

/**
 * structure JSON → 嵌套节点（纯几何：实时状态在 LiveContext，不进 node.data）。
 * 无持久化位置的子卡在父内容区单列自动摆（确定性，refetch 稳定）；
 * 父卡尺寸 = 子卡 bounds + 内边距。父节点必须先于子节点入数组。
 */
function deriveNodes(cards: CardModel[], local: Map<string, CanvasFlowNode>): CanvasFlowNode[] {
  const nodes: CanvasFlowNode[] = [];
  for (const card of cards) {
    const sid = srvId(card.node.id);
    const serverLocal = local.get(sid);
    // 先摆子卡，得到服务器卡/分组的尺寸
    const children: CanvasFlowNode[] = [];
    const targetNodes: CanvasFlowNode[] = [];
    let cursor = HEADER_H;
    let contentRight = PAD + CHILD_W;
    let contentBottom = HEADER_H;
    const groupAuto = new Map<number, number>(); // 分组内自动摆放游标
    const groupBounds = new Map<number, { right: number; bottom: number }>();
    for (const t of card.targets) {
      const id = t.kind === "app" ? appId(t.id) : dbId(t.id);
      const parentId = t.groupId ? grpId(t.groupId) : sid;
      let auto: { x: number; y: number };
      if (t.groupId) auto = { x: PAD, y: groupAuto.get(t.groupId) ?? GROUP_HEADER_H + 6 };
      else auto = { x: PAD, y: cursor };
      const pos = t.x !== null && t.y !== null ? { x: t.x, y: t.y } : auto;
      const localNode = local.get(id);
      const position = localNode?.dragging ? localNode.position : pos;
      // app 卡尺寸 = 手动拉伸值（下限）∪ 服务卡 bounds 收敛
      let w = Math.max(CHILD_W, t.w ?? 0);
      let h = t.kind === "app"
        ? Math.max(APP_MIN_H, appContentBottom(t) + APP_TAIL_H, t.h ?? 0)
        : Math.max(DB_H, t.h ?? 0);
      const svcNodes: CanvasFlowNode[] = [];
      if (t.kind === "app") {
        let svcCursor = SVC_TOP;
        for (const s of t.services) {
          const id2 = svcId(t.id, s.name);
          const localSvc = local.get(id2);
          const sh = svcHeight(s);
          const auto2 = { x: 14, y: svcCursor };
          const pos2 = s.x !== undefined && s.y !== undefined ? { x: s.x, y: s.y } : auto2;
          const position2 = localSvc?.dragging ? localSvc.position : pos2;
          svcNodes.push({
            id: id2,
            type: "service",
            parentId: id,
            position: position2,
            width: SVC_W,
            height: sh,
            selected: localSvc?.selected ?? false,
            dragging: localSvc?.dragging,
            data: { t, s },
          } as CanvasFlowNode);
          w = Math.max(w, position2.x + SVC_W + PAD);
          h = Math.max(h, position2.y + sh + APP_TAIL_H);
          svcCursor += sh + SVC_GAP;
        }
      }
      targetNodes.push({
        id,
        type: t.kind,
        parentId,
        position,
        width: w,
        height: h,
        selected: localNode?.selected ?? false,
        dragging: localNode?.dragging,
        data: { t },
      } as CanvasFlowNode);
      targetNodes.push(...svcNodes);
      if (t.groupId) {
        const b = groupBounds.get(t.groupId) ?? { right: 0, bottom: 0 };
        b.right = Math.max(b.right, position.x + w);
        b.bottom = Math.max(b.bottom, position.y + h);
        groupBounds.set(t.groupId, b);
        groupAuto.set(t.groupId, (groupAuto.get(t.groupId) ?? GROUP_HEADER_H + 6) + h + GAP);
      } else {
        contentRight = Math.max(contentRight, position.x + w);
        contentBottom = Math.max(contentBottom, position.y + h);
        cursor += h + GAP;
      }
    }
    // 分组卡（服务器卡的子、app/db 卡的父；尺寸 = 手动值 ∪ 组内子卡 bounds）
    for (const g of card.groups ?? []) {
      const gid = grpId(g.id);
      const gLocal = local.get(gid);
      const b = groupBounds.get(g.id);
      const w = Math.max(GROUP_MIN_W, g.w ?? 0, (b?.right ?? 0) + PAD);
      const h = Math.max(GROUP_MIN_H, g.h ?? 0, (b?.bottom ?? 0) + PAD);
      children.push({
        id: gid,
        type: "group",
        parentId: sid,
        position: gLocal?.dragging ? gLocal.position : { x: g.x, y: g.y },
        width: w,
        height: h,
        selected: gLocal?.selected ?? false,
        dragging: gLocal?.dragging,
        data: { g },
      } as CanvasFlowNode);
      contentRight = Math.max(contentRight, g.x + w);
      contentBottom = Math.max(contentBottom, g.y + h);
    }
    children.push(...targetNodes);
    nodes.push({
      id: sid,
      type: "server",
      position: serverLocal?.dragging ? serverLocal.position : { x: card.node.x, y: card.node.y },
      width: Math.max(PAD + CHILD_W + PAD, contentRight + PAD, card.node.w ?? 0),
      height: Math.max(HEADER_H + APP_MIN_H + PAD, contentBottom + PAD, card.node.h ?? 0),
      selected: serverLocal?.selected ?? false,
      dragging: serverLocal?.dragging,
      data: { server: card.server },
    } as CanvasFlowNode);
    nodes.push(...children);
  }
  return nodes;
}

/** 服务级依赖边：db 卡 → 服务卡（service 有值）或 app 卡（整体依赖）。边 id 编码三者供删边解析 */
function deriveEdges(cards: CardModel[], keepSelected: Set<string>): FlowEdge[] {
  // 透镜过滤后 db 端可能不可见：只画两端都在当前卡集里的边
  const visibleTargets = new Set(cards.flatMap((c) => c.targets.map((t) => t.id)));
  const edges: FlowEdge[] = [];
  for (const c of cards)
    for (const t of c.targets)
      for (const e of t.edges) {
        if (!visibleTargets.has(e.db)) continue;
        const id = `dep-${e.db}-${t.id}-${e.service ?? "_"}`;
        edges.push({
          id,
          source: dbId(e.db),
          target: e.service ? svcId(t.id, e.service) : appId(t.id),
          selected: keepSelected.has(id),
          ...DEP_EDGE,
        });
      }
  return edges;
}

interface Menu {
  x: number; y: number;
  kind: "pane" | "server" | "group";
  nodeId?: number;
  groupId?: number;
  flowX: number; flowY: number;
}

/**
 * 透镜过滤（纯视图，不改服务端数据）：lens 非空时只留该项目的 target，
 * 分组只留仍有可见 target 的（空分组一并隐藏）；服务器空卡保留。
 */
function applyLens(cards: CardModel[], lens: number | null): CardModel[] {
  if (lens == null) return cards;
  return cards.map((card) => {
    const targets = card.targets.filter((t) => t.projectId === lens);
    const visibleGroups = new Set(
      targets.map((t) => t.groupId).filter((g): g is number => g != null),
    );
    return { ...card, targets, groups: (card.groups ?? []).filter((g) => visibleGroups.has(g.id)) };
  });
}

export function Board(props: { lens: () => number | null }) {
  // 三源：structure（/board，refresh 驱动，存普通变量）、nodes（布局，本地权威信号）、live（SSE store）
  const ui = useUi();
  const [servers, setServers] = createSignal<BoardModel["servers"]>([]);
  const [live, setLive] = createStore<LiveState>({ targets: {}, services: {}, logs: {} });
  const [nodes, setNodes] = createSignal<CanvasFlowNode[]>([]);
  const [edges, setEdges] = createSignal<FlowEdge[]>([]);
  const [menu, setMenu] = createSignal<Menu | null>(null);
  let structure: CardModel[] = [];
  let flowApi!: { screenToFlowPosition(p: { x: number; y: number }): { x: number; y: number } };

  /** 结构拉取：只在挂载和 refresh 事件（结构变更）时调用，不轮询。世界地图：全局 /board */
  const fetchBoard = async () => {
    const board = await unwrap(canvasApi.board.get()).catch(() => null);
    if (!board) return;
    structure = board.cards;
    setServers(board.servers);
    setNodes((cur) => deriveNodes(applyLens(board.cards, props.lens()), new Map(cur.map((n) => [n.id, n]))));
    setEdges((cur) => deriveEdges(applyLens(board.cards, props.lens()), new Set(cur.filter((e) => e.selected).map((e) => e.id))));
  };

  // 透镜切换是纯客户端过滤：不走网络，用已拉的 structure 重推导节点/边
  createEffect(() => {
    const cards = applyLens(structure, props.lens());
    setNodes((cur) => deriveNodes(cards, new Map(cur.map((n) => [n.id, n]))));
    setEdges((cur) => deriveEdges(cards, new Set(cur.filter((e) => e.selected).map((e) => e.id))));
  });

  // 交互门闩：拖拽/连线进行中 refresh 排队，结束后补拉——用户交互期间不被自动刷新打断
  let interacting = false;
  let pendingRefetch = false;
  const refetch = async () => {
    if (interacting) {
      pendingRefetch = true;
      return;
    }
    await fetchBoard();
    pendingRefetch = false;
  };
  const flushPendingRefetch = () => {
    if (pendingRefetch && !interacting) {
      pendingRefetch = false;
      void fetchBoard();
    }
  };

  // 结构：挂载拉一次 + refresh 事件（抽屉在结构变更后 dispatch，见 ui.ts）
  onMount(() => {
    void fetchBoard();
    const onRefresh = () => void refetch();
    document.body.addEventListener("refresh", onRefresh);
    onCleanup(() => document.body.removeEventListener("refresh", onRefresh));
  });

  // 实时：全局 SSE——部署 status/running、容器 state，只进 live store（不进 nodes）
  onMount(() => {
    const es = new EventSource(EVENTS_URL);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as Record<string, unknown>;
        if (msg.type === "status" || msg.type === "running") {
          const id = msg.targetId as number;
          const t = live.targets[id] ?? { status: null, running: false };
          setLive("targets", id, msg.type === "status"
            ? { ...t, status: msg.status as never }
            : { ...t, running: Boolean(msg.running) });
        } else if (msg.type === "state") {
          setLive("services", `${msg.targetId}:${msg.service}`, msg.state as never);
        } else if (msg.type === "log") {
          const id = msg.targetId as number;
          const runId = msg.runId as number;
          const incoming = (msg.lines as string[]) ?? [];
          const cur = live.logs[id];
          const base = cur && cur.runId === runId ? cur.lines : [];
          setLive("logs", id, { runId, lines: [...base, ...incoming].slice(-LOG_TAIL_LIMIT) });
        }
      } catch { /* 忽略坏帧 */ }
    };
    onCleanup(() => es.close());
  });

  // ── 节点几何变化（FlowView 回调）──
  // Resizer 拖拽中的节点 id，fitParents 对它们跳过 clamp/grow
  const resizingIds = new Set<string>();

  const onNodeMove = (id: string, pos: { x: number; y: number }) => {
    // 区域硬隔离的体验层：车道是一堵墙，拖拽中把卡片完整矩形钳在本车道内
    // （规则来自 zones.ts 单一事实源，服务端 422 仍是裁决者）
    const dragged = nodes().find((n) => n.id === id);
    let p = pos;
    if (dragged?.type === "server") {
      const local = (dragged.data as { server: { local: boolean } }).server.local;
      p = { x: clampCardX(local, pos.x, dragged.width ?? 0), y: pos.y };
    }
    setNodes((ns) => fitParents(
      ns.map((n) => (n.id === id ? { ...n, position: p, dragging: true } : n)),
      resizingIds,
    ));
  };

  const onNodeResize = (id: string, w: number, h: number, resizing: boolean) => {
    if (resizing) resizingIds.add(id);
    else resizingIds.delete(id);
    // 尺寸取整：亚像素尺寸与 DOM 测量 round-trip 会互相抖动
    setNodes((ns) => ns.map((n) =>
      n.id === id ? { ...n, width: Math.round(w), height: Math.round(h) } : n));
  };

  const onNodeResizeEnd = (_id: string, _w: number, _h: number) => {
    resizingIds.delete(_id);
    setNodes((ns) => fitParents(ns, resizingIds));
  };

  const findTarget = (id: number) =>
    structure.flatMap((c) => c.targets).find((t) => t.id === id);

  const putEdges = async (appTargetId: number, entries: { service: string | null; db: number }[]) => {
    await unwrap(api.targets({ id: appTargetId }).deps.put({ edges: entries }));
    // 边属结构（服务端有派生逻辑），写回后重拉
    await refetch();
  };

  // 删边：id 形如 dep-<db>-<appTargetId>-<service|_>，整组覆盖写回
  const onEdgesRemove = (ids: string[]) => {
    setEdges((es) => es.map((e) => (ids.includes(e.id) ? { ...e, selected: false } : e)));
    for (const id of ids) {
      const m = /^dep-(\d+)-(\d+)-(.+)$/.exec(id);
      if (!m) continue;
      const [, db, app, svc] = m;
      const t = findTarget(Number(app));
      if (!t) continue;
      void putEdges(t.id, t.edges
        .filter((e) => !(e.db === Number(db) && (e.service ?? "_") === svc))
        .map((e) => ({ service: e.service, db: e.db })));
    }
  };

  // 拖线建依赖：db 卡 source（src-<db>）→ 服务卡（tgt-<app>-<svc>）或 app 卡（tgt-<app>）
  const onConnect = (conn: ConnectResult) => {
    const db = Number(/^src-(\d+)$/.exec(conn.sourceHandle ?? "")?.[1]);
    const whole = /^tgt-(\d+)$/.exec(conn.targetHandle ?? "");
    const perSvc = /^tgt-(\d+)-(.+)$/.exec(conn.targetHandle ?? "");
    if (!db || (!whole && !perSvc)) return;
    const appTargetId = Number((perSvc ?? whole)![1]);
    const service = perSvc ? perSvc[2]! : null;
    const t = findTarget(appTargetId);
    if (!t || t.edges.some((e) => e.db === db && e.service === service)) return;
    void putEdges(t.id, [...t.edges.map((e) => ({ service: e.service, db: e.db })), { service, db }]);
  };

  // 布局：本地已是权威，PATCH 只持久化，不 refetch
  const patchLayout = (targetId: number, body: {
    x?: number; y?: number; w?: number; h?: number;
    groupId?: number | null;
    serviceLayout?: Record<string, { x: number; y: number }>;
  }) => unwrap(api.targets({ id: targetId }).layout.patch(body));

  // 服务器卡内绝对坐标（app/db 的 parent 可能是分组，position 是相对父的）
  const absInServer = (node: CanvasFlowNode): { x: number; y: number; serverId: string } => {
    let x = node.position.x, y = node.position.y;
    let parent = node.parentId;
    let cur = node;
    const all = nodes();
    while (parent) {
      const p = all.find((n) => n.id === parent);
      if (!p) break;
      x += p.position.x;
      y += p.position.y;
      cur = p;
      parent = p.parentId;
    }
    return { x, y, serverId: cur.type === "server" ? cur.id : "" };
  };

  // 拖拽起点（flow 坐标，相对父）：拖拽被拒时动画弹回这里
  const dragOrigin = new Map<string, { x: number; y: number }>();

  /** 动画弹回：dragging 已置 false（NodeShell 的 left/top 过渡生效），位置补间回起点 */
  const bounce = (id: string) => {
    const o = dragOrigin.get(id);
    if (o) setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, position: { ...o } } : n)));
  };

  const onNodeDragStart = (node: CanvasFlowNode) => {
    interacting = true;
    dragOrigin.set(node.id, { ...node.position });
  };

  const onNodeDragStop = async (node: CanvasFlowNode) => {
    interacting = false;
    setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, dragging: false } : n)));
    const x = Math.round(node.position.x), y = Math.round(node.position.y);
    if (node.type === "server") {
      const nodeId = Number(node.id.replace("srv-", ""));
      // onNodeMove 已把分界线钳成墙，这里只剩服务端 422 兜底（如存量脏数据卡在对侧）
      try {
        await unwrap(canvasApi.nodes({ id: nodeId }).patch({ x, y }));
      } catch (e) {
        toast((e as Error).message, "err");
        bounce(node.id);
      }
      flushPendingRefetch();
      return;
    } else if (node.type === "group") {
      void unwrap(canvasApi.groups({ id: Number(node.id.replace("grp-", "")) }).patch({ x, y }));
    } else if (node.type === "app" || node.type === "db") {
      const targetId = Number(node.id.replace(/^(app|db)-/, ""));
      // 分组命中测试：卡片中心落在哪个分组矩形内（无 → 直属服务器卡）
      const abs = absInServer(node);
      const cx = abs.x + (node.width ?? 0) / 2, cy = abs.y + (node.height ?? 0) / 2;

      // 跨服务器迁移：卡片中心落在另一台服务器卡矩形内 → 走 move 通道（区域硬隔离由服务端裁决）
      const srvHit = nodes().find((n) =>
        n.type === "server" && n.id !== abs.serverId &&
        cx >= n.position.x && cx <= n.position.x + (n.width ?? 0) &&
        cy >= n.position.y && cy <= n.position.y + (n.height ?? 0));
      if (srvHit) {
        const t = findTarget(targetId);
        const from = structure.find((c) => `srv-${c.node.id}` === abs.serverId);
        const to = structure.find((c) => `srv-${c.node.id}` === srvHit.id);
        const revert = () => bounce(node.id); // 动画弹回拖拽起点
        const crossing = from && to && from.server.local !== to.server.local;
        if (crossing && t) {
          // 体验层预判（服务端仍兜底）：跨界要么 app 且产物已传输，要么拒绝
          if (t.kind !== "app") {
            toast("数据库不能跨区移动——数据不随卡走，请在目标服务器新建实例。", "err");
            return revert();
          }
          if (!t.artifactShipped) {
            toast("构建产物尚未传输到云端——先在服务抽屉执行「传输产物」。", "err");
            return revert();
          }
          // 决策期间把卡钉在落点（dragging=true 让 deriveNodes 不用结构值覆盖它，
          // 否则确认框打开期间一次 refetch 会把卡瞬移回起点——原生 confirm 是同步阻塞，没这个问题）
          setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, dragging: true } : n)));
          const ok = await confirmAction({
            title: `迁移「${t.name}」到「${to.server.name}」？`,
            body: "跨区迁移要求构建产物已传输；旧服务器上的容器不会自动清理。",
            confirmLabel: "迁移",
          });
          if (!ok) {
            setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, dragging: false } : n)));
            return revert();
          }
        }
        void (async () => {
          try {
            await unwrap(api.targets({ id: targetId }).move.patch({ nodeId: to!.node.id }));
            // 成功：归属变了，清钉住标记让 deriveNodes 用新结构（x/y 已清 null → 自动摆位）
            setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, dragging: false } : n)));
            await refetch();
          } catch (e) {
            toast(`迁移被拒绝：${(e as Error).message}`, "err");
            setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, dragging: false } : n)));
            bounce(node.id);
          }
        })();
        flushPendingRefetch();
        return;
      }

      const groups = nodes().filter((g) => g.type === "group" && g.parentId === abs.serverId);
      const hit = groups.find((g) => {
        const ga = absInServer(g);
        return cx >= ga.x && cx <= ga.x + (g.width ?? 0) && cy >= ga.y && cy <= ga.y + (g.height ?? 0);
      });
      const curGroup = node.parentId?.startsWith("grp-") ? Number(node.parentId.slice(4)) : null;
      const newGroup = hit ? Number(hit.id.slice(4)) : null;
      if (newGroup !== curGroup) {
        // 换父：坐标换算成新父内相对值，结构变化走 refetch
        const rel = hit
          ? (() => { const ga = absInServer(hit); return { x: Math.round(abs.x - ga.x), y: Math.round(abs.y - ga.y) }; })()
          : { x: Math.round(abs.x), y: Math.round(abs.y) };
        void (async () => {
          await patchLayout(targetId, { groupId: newGroup, ...rel });
          await refetch();
        })();
      } else {
        void patchLayout(targetId, { x, y });
      }
    } else if (node.type === "service") {
      const data = node.data as { t: TargetModel; s: { name: string } };
      // serviceLayout 全量覆盖：已知服务位置合并本次移动
      const merged = Object.fromEntries(
        data.t.services.filter((s) => s.x !== undefined && s.y !== undefined)
          .map((s) => [s.name, { x: s.x!, y: s.y! }]),
      );
      merged[data.s.name] = { x, y };
      void patchLayout(data.t.id, { serviceLayout: merged });
    }
    flushPendingRefetch();
  };

  const closeMenu = () => setMenu(null);

  // 点服务卡/db 卡 → Railway 式服务抽屉（FlowView 内部已抑制拖拽后的误点击）
  const onNodeClick = (_e: MouseEvent, node: CanvasFlowNode) => {
    closeMenu();
    if (node.type === "service") {
      const { t, s } = node.data as { t: TargetModel; s: { name: string } };
      ui.open({ kind: "service", targetId: t.id, svc: s.name });
    } else if (node.type === "db") {
      const { t } = node.data as { t: TargetModel };
      ui.open({ kind: "service", targetId: t.id });
    }
  };

  // 车道背景：本机/远程两个车道矩形从卡片 bounds 派生（内缘钉在中立带，zones.ts 单一事实源），
  // 车道即容器——tint 就是约束的可视化，墙与背景不可能脱节。渲染在 FlowView transform 层内随 pan/zoom。
  const lanes = createMemo(() => {
    const srvs = nodes().filter((n) => n.type === "server");
    const rectOf = (local: boolean) =>
      laneRect(local, srvs
        .filter((n) => (n.data as { server: { local: boolean } }).server.local === local)
        .map((n) => ({ x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 })));
    return [
      { local: true, label: "本机", rect: rectOf(true), cls: "border-tide-400/20 bg-tide-400/[0.04] text-tide-400/60" },
      { local: false, label: "远程", rect: rectOf(false), cls: "border-brass-500/20 bg-brass-500/[0.03] text-brass-500/60" },
    ];
  });
  const laneBackground = (
    <For each={lanes()}>
      {(lane) => (
        <div
          class={`pointer-events-none absolute rounded-xl border border-dashed ${lane.cls}`}
          style={{
            left: `${lane.rect.x}px`, top: `${lane.rect.y}px`,
            width: `${lane.rect.w}px`, height: `${lane.rect.h}px`,
          }}
        >
          <span class="absolute top-3 left-4 text-xs font-medium tracking-widest select-none">
            {lane.label}
          </span>
        </div>
      )}
    </For>
  );

  return (
    <LiveContext.Provider value={live}>
      <FlowView
        nodes={nodes()}
        edges={edges()}
        nodeViews={nodeViews}
        background={laneBackground}
        onNodeMove={onNodeMove}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onNodeResize={onNodeResize}
        onNodeResizeEnd={onNodeResizeEnd}
        onNodeSelect={(id) => setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })))}
        onEdgeSelect={(id) => setEdges((es) => es.map((e) => ({ ...e, selected: e.id === id })))}
        onEdgesRemove={onEdgesRemove}
        onConnect={onConnect}
        fitView
        minZoom={0.2}
        ref={(a) => { flowApi = a; }}
        onPaneContextMenu={(e) => {
          if (servers().length === 0) return;
          const p = flowApi.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          setMenu({ x: e.clientX, y: e.clientY, kind: "pane", flowX: Math.round(p.x), flowY: Math.round(p.y) });
        }}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          if (node.type === "server")
            setMenu({ x: e.clientX, y: e.clientY, kind: "server", nodeId: Number(node.id.replace("srv-", "")), flowX: 0, flowY: 0 });
          else if (node.type === "group")
            setMenu({ x: e.clientX, y: e.clientY, kind: "group", groupId: Number(node.id.replace("grp-", "")), flowX: 0, flowY: 0 });
          // app/db 卡的操作在卡片按钮上
        }}
        onPaneClick={closeMenu}
        onMoveStart={closeMenu}
      />

      <Show when={menu()}>
        {(m) => (
          <div
            data-flow-menu class="fixed z-50 min-w-40 rounded border border-harbor-700 bg-harbor-900 py-1 shadow-2xl"
            style={{ left: `${m().x}px`, top: `${m().y}px` }}
            onClick={closeMenu}
          >
            {m().kind === "group" && m().groupId != null ? (
              <>
                <MenuItem
                  label="重命名分组"
                  onClick={async () => {
                    const name = await promptAction({ title: "重命名分组" });
                    if (!name?.trim()) return;
                    await unwrap(canvasApi.groups({ id: m().groupId! }).patch({ name: name.trim() }));
                    await refetch();
                  }}
                />
                <MenuItem
                  label="删除分组"
                  danger
                  onClick={async () => {
                    const ok = await confirmAction({
                      title: "删除分组？",
                      body: "组内服务卡会回落到服务器卡（部署不动）。",
                      confirmLabel: "删除",
                      danger: true,
                    });
                    if (!ok) return;
                    await unwrap(canvasApi.groups({ id: m().groupId! }).delete());
                    await refetch();
                  }}
                />
              </>
            ) : m().kind === "server" && m().nodeId != null ? (
              <>
                {/* 建内容（部署目标）需要项目归属：世界视图（无透镜）下禁用 */}
                <MenuItem
                  label="部署本仓库"
                  disabled={props.lens() == null}
                  onClick={() => ui.open({ kind: "new-app", nodeId: m().nodeId! })}
                />
                <MenuItem
                  label="添加数据库"
                  disabled={props.lens() == null}
                  onClick={() => ui.open({ kind: "new-db", nodeId: m().nodeId! })}
                />
                <MenuItem
                  label="新建分组"
                  onClick={async () => {
                    const name = await promptAction({ title: "新建分组", initial: "group" });
                    if (!name?.trim()) return;
                    await unwrap(canvasApi.nodes({ id: m().nodeId! }).groups.post({ name: name.trim() }));
                    await refetch();
                  }}
                />
                <MenuItem
                  label="移除卡片"
                  danger
                  onClick={async () => {
                    const ok = await confirmAction({
                      title: "移除这张卡片？",
                      body: "只是从画布移除卡片，服务器与部署目标不动。",
                      confirmLabel: "移除",
                      danger: true,
                    });
                    if (!ok) return;
                    await unwrap(canvasApi.nodes({ id: m().nodeId! }).delete());
                    await refetch();
                  }}
                />
              </>
            ) : (
              <For each={servers()}>
                {(s) => (
                  <MenuItem
                    label={`＋ ${s.name}`}
                    onClick={async () => {
                      // 世界地图：建卡无 projectId（服务端幂等——同服务器已上画则返回已有卡）
                      await unwrap(canvasApi.nodes.post({ serverId: s.id, x: m().flowX, y: m().flowY }));
                      await refetch();
                    }}
                  />
                )}
              </For>
            )}
          </div>
        )}
      </Show>
    </LiveContext.Provider>
  );
}

function MenuItem(props: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      class={`block w-full px-3 py-1.5 text-left text-sm ${
        props.disabled
          ? "cursor-not-allowed text-neutral-600"
          : `hover:bg-harbor-800 ${props.danger ? "text-signal-500" : "text-neutral-200"}`
      }`}
      disabled={props.disabled}
      title={props.disabled ? "先在右上角选择一个项目" : undefined}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}
