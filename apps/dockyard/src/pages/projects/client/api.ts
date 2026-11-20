/** projects client 的 API 层：Eden Treaty 端到端类型客户端（路径/params/body 全类型安全）。 */
import { treaty } from "@elysia/eden";
import type { ProjectApi } from "../projects.socket";

export const api = treaty<ProjectApi>(`${location.origin}/api/projects`);

export { unwrap } from "@/shared/solid-ui/api";
