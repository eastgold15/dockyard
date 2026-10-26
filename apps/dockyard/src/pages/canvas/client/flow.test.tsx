/** @jsxImportSource solid-js */
// client 原子测试样例：DOM 与 Solid JSX 编译由 test/preload.ts 装配（bunfig [test].preload）。
// pragma 只服务 tsc（dockyard 全局 jsxImportSource 是 @kitajs/html）；运行时 .tsx 由
// preload 里的 solidPlugin 编译，不读 pragma。
// 约定：client 组件测试放组件旁边（*.test.tsx），只断 DOM 结构与行为钩子，不断样式。
import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { HandleView } from "@elysiax/flow";

test("HandleView 渲染连接点行为钩子", () => {
  const el = document.createElement("div");
  const dispose = render(() => <HandleView type="source" id="src-1" title="拖线起点" />, el);
  const handle = el.querySelector("[data-handle-id='src-1']");
  expect(handle).not.toBeNull();
  expect(handle!.getAttribute("data-handle-type")).toBe("source");
  // data-nodrag 是拖拽系统的行为钩子：Handle 不触发节点拖拽
  expect(handle!.hasAttribute("data-nodrag")).toBe(true);
  dispose();
});
