import { definePage } from "@elysiax/core";

/**
 * 根页面：职责是门户。当前无跨模块聚合需求，先重定向到 /projects；
 * 真做 dashboard 时改成 PageResult，数据走各业务 partials 的挂载点（壳准入三条）。
 */
export default definePage(
  () => new Response(null, { status: 302, headers: { location: "/projects" } }),
);
