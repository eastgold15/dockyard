import { defineRoutes } from "../../../.elysiax";

/** ping 测试页的 JSON API：整页 Solid 后不再提供 HTML 片段。 */
export default defineRoutes().get("/hello", () => ({ message: "hello fragment ✅" }));
