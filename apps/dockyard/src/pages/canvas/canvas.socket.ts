// canvas 原子的插座：表锚点（canvas_nodes/service_groups）+ 画布服务。
export { canvasNodes, serviceGroups } from "./schema";
export type { CanvasNode, ServiceGroup } from "./schema";
export { CanvasService } from "./canvas.service";

/** 回环地址判定（只用于「添加服务器」门禁）：正主在 servers.socket。
 *  运行期「本机」语义一律以 servers.builtin 为准，不要用它派生通道/车道/门票——
 *  `pori@127.0.0.1:2222` 是用户的 SSH 隧道，不是内置本机。转出口仅保既有引用。 */
export { isLocalHost } from "../servers/servers.socket";

/** 发现层变更指纹（container-poller 跨原子消费，正主在 discovery.ts） */
export { discoverySignature } from "./discovery";

// Eden Treaty 的 API 类型出口（同原子 client 引用）
import type canvasApi from "./canvas.actions";
export type CanvasApi = typeof canvasApi;
