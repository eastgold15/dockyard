/** ping client 的 API 层：Eden Treaty 端到端类型客户端。 */
import { treaty } from "@elysia/eden";
import type pingActions from "../ping.actions";

export const api = treaty<typeof pingActions>(`${location.origin}/api/ping`);

export { unwrap } from "../../../shared/solid-ui/api";
