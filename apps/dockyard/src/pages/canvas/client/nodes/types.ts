/** @jsxImportSource solid-js */
/** 画布 flow 节点类型：服务器 → app → 服务；db 直属服务器，分组是容器。 */
import type { FlowNodeBase } from "@elysiax/flow";
import type { CardModel, DiscoveredContainer, GroupModel, ServiceRow, TargetModel } from "../../canvas.model";

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
