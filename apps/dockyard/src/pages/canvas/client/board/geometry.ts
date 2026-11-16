/** @jsxImportSource solid-js */
/** 画布几何常量与节点视图映射：尺寸估算与 nodes.tsx 的 Tailwind 类对应，改一处要同步另一处。 */
import type { TargetModel } from "../../canvas.model";
import type { NodeViewProps } from "@elysiax/flow";
import {
  AppNodeView,
  ContainerNodeView,
  DbNodeView,
  GroupNodeView,
  ServerNodeView,
  ServiceNodeView,
} from "../nodes";
export const nodeViews = {
  server: ServerNodeView,
  app: AppNodeView,
  service: ServiceNodeView,
  db: DbNodeView,
  group: GroupNodeView,
  container: ContainerNodeView,
} as unknown as Record<string, (p: NodeViewProps<never>) => Element>;

// 依赖边样式（虚线黄铜 + 箭头）
export const DEP_EDGE = {
  stroke: "#d9a441",
  strokeOpacity: 0.6,
  strokeWidth: 1.5,
  strokeDasharray: "5 3",
  arrowColor: "#d9a441",
} as const;

// ── 布局常量（父卡显式尺寸由子卡 bounds 算，估算值与 nodes.tsx 的 Tailwind 类对应）──
export const CHILD_W = 320; // app/db 卡宽
export const SVC_H = 34,
  SVC_GAP = 4,
  SVC_TOP = 36; // 服务卡在 app 卡内：x=0，y 从 SVC_TOP 起按实际高度累加（卡面只留一行项目名）
export const SVC_DOMAIN_H = 16; // 服务卡里每行域名的高度
export const APP_MIN_H = 56; // 无服务清单的 app 卡高
export const APP_TAIL_H = 8; // 服务块之后的底部留白（按钮区已收进 Sidebar）
export const DB_H = 56;
export const DISC_H = 66; // 发现容器卡高（只读行：名称/镜像/端口）
export const PAD = 14,
  HEADER_H = 56,
  GAP = 12; // 服务器卡：内边距/标题/子卡间距
export const SVC_W = CHILD_W;
export const GROUP_HEADER_H = 30; // 分组卡标题高度
export const GROUP_MIN_W = 220,
  GROUP_MIN_H = 120;

export const srvId = (nodeId: number) => `srv-${nodeId}`;
export const appId = (targetId: number) => `app-${targetId}`;
export const svcId = (targetId: number, name: string) => `svc-${targetId}-${name}`;
export const dbId = (targetId: number) => `db-${targetId}`;
export const grpId = (groupId: number) => `grp-${groupId}`;
export const discId = (containerId: string) => `disc-${containerId}`;

/** 服务行高 = 服务名一行 + 域名行数（服务名/域名作为普通文本行流式渲染在 app 卡盒内） */
export const svcHeight = (s: TargetModel["services"][number]) =>
  SVC_H + s.domains.length * SVC_DOMAIN_H;

/** app 卡内容高 = header + 服务行累加 + 底部留白（服务不再嵌套子节点，卡盒内流式） */
export const appContentBottom = (t: TargetModel) =>
  t.services.reduce((y, s) => y + svcHeight(s) + SVC_GAP, SVC_TOP);

/**
 * 拖拽时父卡随子卡撑大（grow-only，只长不缩避免抖动；结构 refetch 时由 deriveNodes 精确收敛）。
 * resizingIds：Resizer 拖拽中的节点必须跳过 clamp 和 grow——否则 grow-only 把用户缩小的尺寸
 * 立刻 max 回去，与 Resizer 互相覆盖抖动。
 */
