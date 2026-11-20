/** @jsxImportSource @solidjs/web */
/** 画布数据派生：父子尺寸收敛、节点/边派生、透镜过滤。纯函数，不碰 DOM。 */
import type { CardModel, DiscoveredContainer, TargetModel } from "../../canvas.model";
import type { FlowEdge } from "@elysiax/flow";
import type { CanvasFlowNode } from "../nodes";
import {
  DEP_EDGE,
  APP_MIN_H,
  APP_TAIL_H,
  CHILD_W,
  DB_H,
  DISC_H,
  GROUP_HEADER_H,
  GROUP_MIN_W,
  PAD,
  SVC_DOMAIN_H,
  GAP,
  GROUP_MIN_H,
  HEADER_H,
  SVC_GAP,
  SVC_H,
  SVC_TOP,
  SVC_W,
  appId,
  appContentBottom,
  dbId,
  discId,
  grpId,
  svcHeight,
  svcId,
  srvId,
} from "./geometry";
export function fitParents(
  ns: CanvasFlowNode[],
  resizingIds?: ReadonlySet<string>,
): CanvasFlowNode[] {
  // 钳制子卡不越出父卡内容区（左/上）——服务卡/app 卡不能拖到标题栏或负坐标
  const clamped = ns.map((n) => {
    if (resizingIds?.has(n.id)) return n;
    if (n.type === "service") {
      const x = Math.max(PAD, n.position.x),
        y = Math.max(SVC_TOP, n.position.y);
      return x === n.position.x && y === n.position.y
        ? n
        : { ...n, position: { x, y } };
    }
    if (
      (n.type === "app" || n.type === "db" || n.type === "container") &&
      n.parentId
    ) {
      const x = Math.max(PAD, n.position.x),
        y = Math.max(HEADER_H, n.position.y);
      return x === n.position.x && y === n.position.y
        ? n
        : { ...n, position: { x, y } };
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
  const grow = (
    n: CanvasFlowNode,
    minW: number,
    minH: number,
    padX: number,
    padBottom: number,
  ): CanvasFlowNode => {
    if (resizingIds?.has(n.id)) return n; // Resizer 拖拽中：尊重其精确尺寸
    const kids = kidsOf.get(n.id);
    if (!kids?.length) return n;
    const w = Math.max(
      n.width ?? 0,
      minW,
      ...kids.map((k) => k.position.x + (k.width ?? 0) + padX),
    );
    const h = Math.max(
      n.height ?? 0,
      minH,
      ...kids.map((k) => k.position.y + (k.height ?? 0) + padBottom),
    );
    return w === n.width && h === n.height ? n : { ...n, width: w, height: h };
  };
  return ns.map((n) =>
    n.type === "app"
      ? grow(n, CHILD_W, APP_MIN_H, PAD, APP_TAIL_H)
      : n.type === "group"
        ? grow(n, GROUP_MIN_W, GROUP_MIN_H, PAD, PAD)
        : n.type === "server"
          ? grow(n, PAD + CHILD_W + PAD, HEADER_H + APP_MIN_H + PAD, PAD, PAD)
          : n,
  );
}

/**
 * structure JSON → 嵌套节点（纯几何：实时状态在 LiveContext，不进 node.data）。
 * 无持久化位置的子卡在父内容区单列自动摆（确定性，refetch 稳定）；
 * 父卡尺寸 = 子卡 bounds + 内边距。父节点必须先于子节点入数组。
 */
export function deriveNodes(
  cards: CardModel[],
  local: Map<string, CanvasFlowNode>,
): CanvasFlowNode[] {
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
      if (t.groupId)
        auto = { x: PAD, y: groupAuto.get(t.groupId) ?? GROUP_HEADER_H + 6 };
      else auto = { x: PAD, y: cursor };
      const pos = t.x !== null && t.y !== null ? { x: t.x, y: t.y } : auto;
      const localNode = local.get(id);
      const position = localNode?.dragging ? localNode.position : pos;
      // app 卡高度 = 顶部项目名 header(36) + 每个服务一行(行高按域名数) + 底部留白；
      // 服务不再是嵌套子节点——服务名/域名直接在卡盒内流式渲染（一个 div 盒子）。
      let w = Math.max(CHILD_W, t.w ?? 0);
      let h =
        t.kind === "app"
          ? Math.max(APP_MIN_H, appContentBottom(t) + APP_TAIL_H, t.h ?? 0)
          : Math.max(DB_H, t.h ?? 0);
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
      if (t.groupId) {
        const b = groupBounds.get(t.groupId) ?? { right: 0, bottom: 0 };
        b.right = Math.max(b.right, position.x + w);
        b.bottom = Math.max(b.bottom, position.y + h);
        groupBounds.set(t.groupId, b);
        groupAuto.set(
          t.groupId,
          (groupAuto.get(t.groupId) ?? GROUP_HEADER_H + 6) + h + GAP,
        );
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
    // 发现容器（只读）：排在部署目标/分组下方，单列自动摆；位置不持久化（刷新即归位）
    let discCursor = contentBottom + GAP;
    for (const d of card.discovered ?? []) {
      const id = discId(d.id);
      const discLocal = local.get(id);
      const position = discLocal?.dragging
        ? discLocal.position
        : { x: PAD, y: discCursor };
      targetNodes.push({
        id,
        type: "container",
        parentId: sid,
        position,
        width: CHILD_W,
        height: DISC_H,
        selected: discLocal?.selected ?? false,
        dragging: discLocal?.dragging,
        data: { d },
      } as CanvasFlowNode);
      contentRight = Math.max(contentRight, position.x + CHILD_W);
      contentBottom = Math.max(contentBottom, position.y + DISC_H);
      discCursor += DISC_H + GAP;
    }
    children.push(...targetNodes);
    nodes.push({
      id: sid,
      type: "server",
      position: serverLocal?.dragging
        ? serverLocal.position
        : { x: card.node.x, y: card.node.y },
      width: Math.max(
        PAD + CHILD_W + PAD,
        contentRight + PAD,
        card.node.w ?? 0,
      ),
      height: Math.max(
        HEADER_H + APP_MIN_H + PAD,
        contentBottom + PAD,
        card.node.h ?? 0,
      ),
      selected: serverLocal?.selected ?? false,
      dragging: serverLocal?.dragging,
      data: { server: card.server },
    } as CanvasFlowNode);
    nodes.push(...children);
  }
  return nodes;
}

/** 服务级依赖边：db 卡 → 服务卡（service 有值）或 app 卡（整体依赖）。边 id 编码三者供删边解析 */
export function deriveEdges(
  cards: CardModel[],
  keepSelected: Set<string>,
): FlowEdge[] {
  // 透镜过滤后依赖端可能不可见：只画两端都在当前卡集里的边。
  // 依赖端可能是托管 db 卡，也可能是用户 compose 里自带库的单服务 app 卡（边源按 kind 解析）
  const kindOf = new Map(
    cards.flatMap((c) => c.targets.map((t) => [t.id, t.kind] as const)),
  );
  const edges: FlowEdge[] = [];
  for (const c of cards)
    for (const t of c.targets)
      for (const e of t.edges) {
        const kind = kindOf.get(e.db);
        if (!kind) continue;
        const id = `dep-${e.db}-${t.id}-${e.service ?? "_"}`;
        edges.push({
          id,
          source: kind === "app" ? appId(e.db) : dbId(e.db),
          target: e.service ? svcId(t.id, e.service) : appId(t.id),
          selected: keepSelected.has(id),
          ...DEP_EDGE,
        });
      }
  return edges;
}

export interface Menu {
  x: number;
  y: number;
  kind: "pane" | "server" | "group";
  nodeId?: number;
  groupId?: number;
  flowX: number;
  flowY: number;
}

/**
 * 透镜过滤（纯视图，不改服务端数据）：lens 非空时只留该项目的 target，
 * 分组只留仍有可见 target 的（空分组一并隐藏）；服务器空卡保留。
 */
export function applyLens(cards: CardModel[], lens: number | null): CardModel[] {
  if (lens == null) return cards;
  return cards.map((card) => {
    const targets = card.targets.filter((t) => t.projectId === lens);
    const visibleGroups = new Set(
      targets.map((t) => t.groupId).filter((g): g is number => g != null),
    );
    // 发现容器同样跟透镜走：归属匹配到选中项目的才显示（无归属只在世界视图出现）
    const discovered = (card.discovered ?? []).filter(
      (d) => d.projectId === lens,
    );
    return {
      ...card,
      targets,
      discovered,
      groups: (card.groups ?? []).filter((g) => visibleGroups.has(g.id)),
    };
  });
}

