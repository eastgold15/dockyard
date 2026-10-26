// servers 原子的插座：对外承诺的全部契约。原子内部随便重构，本文件导出保持稳定。
// 规则：跨原子 import 只允许指向本文件；client（浏览器包）只允许 import type（值会打进浏览器包）。
export { servers } from "./schema";
export type { Server } from "./schema";
export { ServerService } from "./servers.service";

/** 本机服务器判定（部署通道分界线）：回环地址派生，不落库；servers/canvas/deploy 共用正主在此 */
export const isLocalHost = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "::1";
