/** servers client 的 API 层：Eden Treaty 端到端类型客户端（路径/params/body 全类型安全）。 */
import { treaty } from "@elysia/eden";
import type { ServerApi } from "../servers.socket";

export const api = treaty<ServerApi>(`${location.origin}/api/servers`);

export { unwrap } from "@/shared/solid-ui/api";
