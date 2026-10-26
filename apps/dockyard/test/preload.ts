// bun test 预加载（bunfig.toml [test].preload）：happy-dom 全局 DOM +
// Solid JSX 预编译。filter 收窄：dockyard 是 htmx + Solid 混用应用，
// @elysiax/htmx 的 .tsx 是 @kitajs/html 语义，被 Solid 编译会注入
// solid-js/web 而解析失败——只放行本应用 client/ 与 @elysiax/flow 的源。
import { setupClientTest } from "@elysiax/solid/testing";

setupClientTest({
  filter: /(apps\/dockyard\/src\/pages\/.*\/client|packages\/flow\/src).*\.tsx$/,
});
