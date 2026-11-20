/** @jsxImportSource solid-js */
/** 画布主体：FlowView 装配、拖拽/缩放持久化、区域车道钳制、右键菜单。 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type {
  BoardModel,
  CardModel,
  DiscoveredContainer,
  TargetModel,
} from "../../canvas.model";
import { api, canvasApi, unwrap } from "../infra/api";
import { useUi } from "../infra/ui";
import { confirmAction, promptAction, toast } from "@/shared/solid-ui/feedback";
import { clampCardX, laneRect } from "../../domain/zones";
import {
  FlowView,
  type ConnectResult,
  type FlowEdge,
  type NodeViewProps,
} from "@elysiax/flow";
import { ContextMenu, useContextMenuContext } from "@kobalte/core/context-menu";
import { menu } from "../../../../../styled-system/recipes";
import { cx } from "../../../../../styled-system/css";
import type { CanvasFlowNode } from "../nodes";
import { nodeViews } from "./geometry";
import { applyLens, deriveEdges, deriveNodes, fitParents, type Menu } from "./derive";
import { MenuGate } from "./menu";
export function Board(props: { lens: () => number | null }) {
  // 三源：structure（/board，refresh 驱动，存普通变量）、nodes（布局，本地权威信号）、live（SSE store）
  const ui = useUi();
  const [servers, setServers] = createSignal<BoardModel["servers"]>([]);
  const [nodes, setNodes] = createSignal<CanvasFlowNode[]>([]);
  const [edges, setEdges] = createSignal<FlowEdge[]>([]);
  const [menuState, setMenuState] = createSignal<Menu | null>(null);
  let structure: CardModel[] = [];
  let flowApi!: {
    screenToFlowPosition(p: { x: number; y: number }): { x: number; y: number };
  };

  /** 结构拉取：只在挂载和 refresh 事件（结构变更）时调用，不轮询。世界地图：全局 /board */
  const fetchBoard = async () => {
    const board = await unwrap(canvasApi.board.get()).catch(() => null);
    if (!board) return;
    structure = board.cards;
    setServers(board.servers);
    setNodes((cur) =>
      deriveNodes(
        applyLens(board.cards, props.lens()),
        new Map(cur.map((n) => [n.id, n])),
      ),
    );
    setEdges((cur) =>
      deriveEdges(
        applyLens(board.cards, props.lens()),
        new Set(cur.filter((e) => e.selected).map((e) => e.id)),
      ),
    );
  };

  // 透镜切换是纯客户端过滤：不走网络，用已拉的 structure 重推导节点/边
  createEffect(() => {
    const cards = applyLens(structure, props.lens());
    setNodes((cur) => deriveNodes(cards, new Map(cur.map((n) => [n.id, n]))));
    setEdges((cur) =>
      deriveEdges(
        cards,
        new Set(cur.filter((e) => e.selected).map((e) => e.id)),
      ),
    );
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

  // 实时状态（SSE → live store）住在 App 层的 <LiveProvider>，Board 只消费 context：
  // 发现层的 refresh 由 provider 统一派发到 body，这里原有的监听照常接住。
  // ── 节点几何变化（FlowView 回调）──
  // Resizer 拖拽中的节点 id，fitParents 对它们跳过 clamp/grow
  const resizingIds = new Set<string>();

  const onNodeMove = (id: string, pos: { x: number; y: number }) => {
    // 区域硬隔离的体验层：车道是一堵墙，拖拽中把卡片完整矩形钳在本车道内
    // （规则来自 zones.ts 单一事实源，服务端 422 仍是裁决者）
    const dragged = nodes().find((n) => n.id === id);
    let p = pos;
    if (dragged?.type === "server") {
      const local = (dragged.data as { server: { local: boolean } }).server
        .local;
      p = { x: clampCardX(local, pos.x, dragged.width ?? 0), y: pos.y };
    }
    setNodes((ns) =>
      fitParents(
        ns.map((n) =>
          n.id === id ? { ...n, position: p, dragging: true } : n,
        ),
        resizingIds,
      ),
    );
  };

  const onNodeResize = (
    id: string,
    w: number,
    h: number,
    resizing: boolean,
  ) => {
    if (resizing) resizingIds.add(id);
    else resizingIds.delete(id);
    // 尺寸取整：亚像素尺寸与 DOM 测量 round-trip 会互相抖动
    setNodes((ns) =>
      ns.map((n) =>
        n.id === id ? { ...n, width: Math.round(w), height: Math.round(h) } : n,
      ),
    );
  };

  const onNodeResizeEnd = (_id: string, _w: number, _h: number) => {
    resizingIds.delete(_id);
    setNodes((ns) => fitParents(ns, resizingIds));
  };

  const findTarget = (id: number) =>
    structure.flatMap((c) => c.targets).find((t) => t.id === id);

  const putEdges = async (
    appTargetId: number,
    entries: { service: string | null; db: number }[],
  ) => {
    await unwrap(api.targets({ id: appTargetId }).deps.put({ edges: entries }));
    // 边属结构（服务端有派生逻辑），写回后重拉
    await refetch();
  };

  // 删边：id 形如 dep-<db>-<appTargetId>-<service|_>，整组覆盖写回
  const onEdgesRemove = (ids: string[]) => {
    setEdges((es) =>
      es.map((e) => (ids.includes(e.id) ? { ...e, selected: false } : e)),
    );
    for (const id of ids) {
      const m = /^dep-(\d+)-(\d+)-(.+)$/.exec(id);
      if (!m) continue;
      const [, db, app, svc] = m;
      const t = findTarget(Number(app));
      if (!t) continue;
      void putEdges(
        t.id,
        t.edges
          .filter((e) => !(e.db === Number(db) && (e.service ?? "_") === svc))
          .map((e) => ({ service: e.service, db: e.db })),
      );
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
    void putEdges(t.id, [
      ...t.edges.map((e) => ({ service: e.service, db: e.db })),
      { service, db },
    ]);
  };

  // 布局：本地已是权威，PATCH 只持久化，不 refetch
  const patchLayout = (
    targetId: number,
    body: {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      groupId?: number | null;
      serviceLayout?: Record<string, { x: number; y: number }>;
    },
  ) => unwrap(api.targets({ id: targetId }).layout.patch(body));

  // 服务器卡内绝对坐标（app/db 的 parent 可能是分组，position 是相对父的）
  const absInServer = (
    node: CanvasFlowNode,
  ): { x: number; y: number; serverId: string } => {
    let x = node.position.x,
      y = node.position.y;
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
    if (o)
      setNodes((ns) =>
        ns.map((n) => (n.id === id ? { ...n, position: { ...o } } : n)),
      );
  };

  const onNodeDragStart = (node: CanvasFlowNode) => {
    interacting = true;
    dragOrigin.set(node.id, { ...node.position });
  };

  /**
   * 拖拽收尾：无论正常落点、被拒弹回还是 pointercancel（cancelled=true），
   * 都必须放开门闩并补拉排队的 refresh —— 否则一次中断就把画布永久冻在旧结构上。
   */
  const onNodeDragStop = async (node: CanvasFlowNode, cancelled?: boolean) => {
    try {
      await commitNodeDrag(node, cancelled);
    } finally {
      interacting = false;
      flushPendingRefetch();
    }
  };

  const commitNodeDrag = async (node: CanvasFlowNode, cancelled?: boolean) => {
    setNodes((ns) =>
      ns.map((n) => (n.id === node.id ? { ...n, dragging: false } : n)),
    );
    if (cancelled) {
      // pointercancel：手势被系统夺走，位置未表态 → 一律弹回起点，不落库
      bounce(node.id);
      return;
    }
    const x = Math.round(node.position.x),
      y = Math.round(node.position.y);
    if (node.type === "server") {
      const nodeId = Number(node.id.replace("srv-", ""));
      // onNodeMove 已把分界线钳成墙，这里只剩服务端 422 兜底（如存量脏数据卡在对侧）
      try {
        await unwrap(canvasApi.nodes({ id: nodeId }).patch({ x, y }));
      } catch (e) {
        toast((e as Error).message, "err");
        bounce(node.id);
      }
      return;
    } else if (node.type === "container") {
      bounce(node.id); // 发现卡只读：拖了弹回原位（不落库）
      return;
    } else if (node.type === "group") {
      void unwrap(
        canvasApi
          .groups({ id: Number(node.id.replace("grp-", "")) })
          .patch({ x, y }),
      );
    } else if (node.type === "app" || node.type === "db") {
      const targetId = Number(node.id.replace(/^(app|db)-/, ""));
      // 分组命中测试：卡片中心落在哪个分组矩形内（无 → 直属服务器卡）
      const abs = absInServer(node);
      const cx = abs.x + (node.width ?? 0) / 2,
        cy = abs.y + (node.height ?? 0) / 2;

      // 跨服务器迁移：卡片中心落在另一台服务器卡矩形内 → 走 move 通道（区域硬隔离由服务端裁决）
      const srvHit = nodes().find(
        (n) =>
          n.type === "server" &&
          n.id !== abs.serverId &&
          cx >= n.position.x &&
          cx <= n.position.x + (n.width ?? 0) &&
          cy >= n.position.y &&
          cy <= n.position.y + (n.height ?? 0),
      );
      if (srvHit) {
        const t = findTarget(targetId);
        const from = structure.find((c) => `srv-${c.node.id}` === abs.serverId);
        const to = structure.find((c) => `srv-${c.node.id}` === srvHit.id);
        const revert = () => bounce(node.id); // 动画弹回拖拽起点
        const crossing = from && to && from.server.local !== to.server.local;
        if (crossing && t) {
          // 体验层预判（服务端仍兜底）：跨界要么 app 且产物已传输，要么拒绝
          if (t.kind !== "app") {
            toast(
              "数据库不能跨区移动——数据不随卡走，请在目标服务器新建实例。",
              "err",
            );
            return revert();
          }
          if (!t.artifactShipped) {
            toast(
              "构建产物尚未传输到云端——先在服务抽屉执行「传输产物」。",
              "err",
            );
            return revert();
          }
          // 决策期间把卡钉在落点（dragging=true 让 deriveNodes 不用结构值覆盖它，
          // 否则确认框打开期间一次 refetch 会把卡瞬移回起点——原生 confirm 是同步阻塞，没这个问题）
          setNodes((ns) =>
            ns.map((n) => (n.id === node.id ? { ...n, dragging: true } : n)),
          );
          const ok = await confirmAction({
            title: `迁移「${t.name}」到「${to.server.name}」？`,
            body: "跨区迁移要求构建产物已传输；旧服务器上的容器不会自动清理。",
            confirmLabel: "迁移",
          });
          if (!ok) {
            setNodes((ns) =>
              ns.map((n) => (n.id === node.id ? { ...n, dragging: false } : n)),
            );
            return revert();
          }
        }
        void (async () => {
          try {
            await unwrap(
              api.targets({ id: targetId }).move.patch({ nodeId: to!.node.id }),
            );
            // 成功：归属变了，清钉住标记让 deriveNodes 用新结构（x/y 已清 null → 自动摆位）
            setNodes((ns) =>
              ns.map((n) => (n.id === node.id ? { ...n, dragging: false } : n)),
            );
            await refetch();
          } catch (e) {
            toast(`迁移被拒绝：${(e as Error).message}`, "err");
            setNodes((ns) =>
              ns.map((n) => (n.id === node.id ? { ...n, dragging: false } : n)),
            );
            bounce(node.id);
          }
        })();
        return;
      }

      const groups = nodes().filter(
        (g) => g.type === "group" && g.parentId === abs.serverId,
      );
      const hit = groups.find((g) => {
        const ga = absInServer(g);
        return (
          cx >= ga.x &&
          cx <= ga.x + (g.width ?? 0) &&
          cy >= ga.y &&
          cy <= ga.y + (g.height ?? 0)
        );
      });
      const curGroup = node.parentId?.startsWith("grp-")
        ? Number(node.parentId.slice(4))
        : null;
      const newGroup = hit ? Number(hit.id.slice(4)) : null;
      if (newGroup !== curGroup) {
        // 换父：坐标换算成新父内相对值，结构变化走 refetch
        const rel = hit
          ? (() => {
              const ga = absInServer(hit);
              return {
                x: Math.round(abs.x - ga.x),
                y: Math.round(abs.y - ga.y),
              };
            })()
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
        data.t.services
          .filter((s) => s.x !== undefined && s.y !== undefined)
          .map((s) => [s.name, { x: s.x!, y: s.y! }]),
      );
      merged[data.s.name] = { x, y };
      void patchLayout(data.t.id, { serviceLayout: merged });
    }
  };

  // 点服务卡/db 卡 → Railway 式服务抽屉（FlowView 内部已抑制拖拽后的误点击）
  const onNodeClick = (_e: MouseEvent, node: CanvasFlowNode) => {
    if (node.type === "service") {
      const { t, s } = node.data as { t: TargetModel; s: { name: string } };
      ui.open({ kind: "service", targetId: t.id, svc: s.name });
    } else if (node.type === "app" || node.type === "db") {
      const { t } = node.data as { t: TargetModel };
      ui.open({ kind: "service", targetId: t.id });
    } else if (node.type === "container") {
      // 发现容器：只读详情（不部署/不回滚）；数据已在 /board 快照里，直接开弹窗
      const { d } = node.data as { d: DiscoveredContainer };
      ui.open({ kind: "discovered", d });
    }
  };

  // 车道背景：本机/远程两个车道矩形从卡片 bounds 派生（内缘钉在中立带，zones.ts 单一事实源），
  // 车道即容器——tint 就是约束的可视化，墙与背景不可能脱节。渲染在 FlowView transform 层内随 pan/zoom。
  const lanes = createMemo(() => {
    const srvs = nodes().filter((n) => n.type === "server");
    const rectOf = (local: boolean) =>
      laneRect(
        local,
        srvs
          .filter(
            (n) =>
              (n.data as { server: { local: boolean } }).server.local === local,
          )
          .map((n) => ({
            x: n.position.x,
            y: n.position.y,
            w: n.width ?? 0,
            h: n.height ?? 0,
          })),
      );
    return [
      {
        local: true,
        label: "本机",
        rect: rectOf(true),
        cls: "border-tide-400/20 bg-tide-400/[0.04] text-tide-400/60",
      },
      {
        local: false,
        label: "远程",
        rect: rectOf(false),
        cls: "border-brass-500/20 bg-brass-500/[0.03] text-brass-500/60",
      },
    ];
  });
  const laneBackground = (
    <For each={lanes()}>
      {(lane) => (
        <div
          class={`pointer-events-none absolute rounded-xl border border-dashed ${lane.cls}`}
          style={{
            left: `${lane.rect.x}px`,
            top: `${lane.rect.y}px`,
            width: `${lane.rect.w}px`,
            height: `${lane.rect.h}px`,
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
    <>
      <ContextMenu>
        {/* 打开桥：FlowView 的右键回调只确定菜单内容（kind/坐标），实际打开与视口内定位、键盘/Esc/焦点交给 Kobalte ContextMenu 管理。 */}
        <MenuGate state={menuState} />
        <ContextMenu.Trigger class="block h-full w-full">
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
            onNodeSelect={(id) =>
              setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })))
            }
            onEdgeSelect={(id) =>
              setEdges((es) => es.map((e) => ({ ...e, selected: e.id === id })))
            }
            onEdgesRemove={onEdgesRemove}
            onConnect={onConnect}
            fitView
            minZoom={0.2}
            ref={(a) => {
              flowApi = a;
            }}
            onPaneContextMenu={(e) => {
              if (servers().length === 0) return;
              const p = flowApi.screenToFlowPosition({
                x: e.clientX,
                y: e.clientY,
              });
              setMenuState({
                x: e.clientX,
                y: e.clientY,
                kind: "pane",
                flowX: Math.round(p.x),
                flowY: Math.round(p.y),
              });
            }}
            onNodeContextMenu={(e, node) => {
              e.preventDefault(); // 抑制原生菜单：Kobalte 由 MenuGate 打开，不走 Trigger 自动打开
              if (node.type === "server")
                setMenuState({
                  x: e.clientX,
                  y: e.clientY,
                  kind: "server",
                  nodeId: Number(node.id.replace("srv-", "")),
                  flowX: 0,
                  flowY: 0,
                });
              else if (node.type === "group")
                setMenuState({
                  x: e.clientX,
                  y: e.clientY,
                  kind: "group",
                  groupId: Number(node.id.replace("grp-", "")),
                  flowX: 0,
                  flowY: 0,
                });
              else setMenuState(null); // app/db/service/container：操作在卡片按钮上，无右键菜单
              // app/db 卡的操作在卡片按钮上
            }}
          />
        </ContextMenu.Trigger>

        <ContextMenu.Portal>
          <ContextMenu.Content class={cx(menu().panel, "z-50")}>
            <Show when={menuState()}>
              {(m) => (
                <>
                  {m().kind === "group" && m().groupId != null ? (
                    <>
                      <ContextMenu.Item
                        class={menu().item}
                        onSelect={async () => {
                          // onSelect 会关菜单（closeOnSelect）：await 前先捕获 ID，避免卸载后访问器失效
                          const groupId = m().groupId!;
                          const name = await promptAction({
                            title: "重命名分组",
                          });
                          if (!name?.trim()) return;
                          await unwrap(
                            canvasApi
                              .groups({ id: groupId })
                              .patch({ name: name.trim() }),
                          );
                          await refetch();
                        }}
                      >
                        重命名分组
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        class={menu({ tone: "danger" }).item}
                        onSelect={async () => {
                          const groupId = m().groupId!;
                          const ok = await confirmAction({
                            title: "删除分组？",
                            body: "组内服务卡会回落到服务器卡（部署不动）。",
                            confirmLabel: "删除",
                            danger: true,
                          });
                          if (!ok) return;
                          await unwrap(
                            canvasApi.groups({ id: groupId }).delete(),
                          );
                          await refetch();
                        }}
                      >
                        删除分组
                      </ContextMenu.Item>
                    </>
                  ) : m().kind === "server" && m().nodeId != null ? (
                    <>
                      {/* 建内容（部署目标）需要项目归属：世界视图（无透镜）下禁用 */}
                      <ContextMenu.Item
                        class={menu().item}
                        disabled={props.lens() == null}
                        title={
                          props.lens() == null
                            ? "先在右上角选择一个项目"
                            : undefined
                        }
                        onSelect={() =>
                          ui.open({
                            kind: "new-app",
                            nodeId: m().nodeId!,
                            projectId: props.lens(),
                          })
                        }
                      >
                        新建服务
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        class={menu().item}
                        disabled={props.lens() == null}
                        title={
                          props.lens() == null
                            ? "先在右上角选择一个项目"
                            : undefined
                        }
                        onSelect={() =>
                          ui.open({
                            kind: "new-db",
                            nodeId: m().nodeId!,
                            projectId: props.lens(),
                          })
                        }
                      >
                        新建数据库
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        class={menu().item}
                        onSelect={async () => {
                          const nodeId = m().nodeId!;
                          const name = await promptAction({
                            title: "新建分组",
                            initial: "group",
                          });
                          if (!name?.trim()) return;
                          await unwrap(
                            canvasApi
                              .nodes({ id: nodeId })
                              .groups.post({ name: name.trim() }),
                          );
                          await refetch();
                        }}
                      >
                        新建分组
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        class={menu({ tone: "danger" }).item}
                        onSelect={async () => {
                          const nodeId = m().nodeId!;
                          const ok = await confirmAction({
                            title: "移除这张卡片？",
                            body: "只是从画布移除卡片，服务器与部署目标不动。",
                            confirmLabel: "移除",
                            danger: true,
                          });
                          if (!ok) return;
                          await unwrap(
                            canvasApi.nodes({ id: nodeId }).delete(),
                          );
                          await refetch();
                        }}
                      >
                        移除卡片
                      </ContextMenu.Item>
                    </>
                  ) : (
                    <For each={servers()}>
                      {(s) => (
                        <ContextMenu.Item
                          class={menu().item}
                          onSelect={async () => {
                            // 世界地图：建卡无 projectId（服务端幂等——同服务器已上画则返回已有卡）
                            const flowX = m().flowX;
                            const flowY = m().flowY;
                            await unwrap(
                              canvasApi.nodes.post({
                                serverId: s.id,
                                x: flowX,
                                y: flowY,
                              }),
                            );
                            await refetch();
                          }}
                        >
                          ＋ {s.name}
                        </ContextMenu.Item>
                      )}
                    </For>
                  )}
                </>
              )}
            </Show>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
    </>
  );
}

/**
 * Kobalte ContextMenu 打开桥：把 Board 的 menuState 信号翻译成 Kobalte 的打开 + 锚点定位调用。
 * FlowView 内部对右键事件已 preventDefault（pane）或 stopPropagation（node），
 * Kobalte Trigger 的自动打开会被这两者拦掉；这里用 useMenuContext/useContextMenuContext
 * 直接调用 Kobalte 的 open 与锚点定位，定位/键盘/Esc/焦点仍全由 Kobalte 管理。
 */
