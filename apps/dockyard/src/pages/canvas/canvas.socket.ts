// canvas 原子的插座：表锚点（canvas_nodes/service_groups）+ 画布服务。
export { canvasNodes, serviceGroups } from "./schema";
export type { CanvasNode, ServiceGroup } from "./schema";
export { CanvasService } from "./canvas.service";

/** 本机/远程判定：正主在 servers.socket（host 概念属于 servers 原子），此处转出口保既有引用 */
export { isLocalHost } from "../servers/servers.socket";

/** 发现层变更指纹（container-poller 跨原子消费，正主在 discovery.ts） */
export { discoverySignature } from "./discovery";

// Eden Treaty 的 API 类型出口（同原子 client 引用）
import type canvasApi from "./canvas.actions";
export type CanvasApi = typeof canvasApi;
