// client 原子测试样例：DOM 与 Solid JSX 编译由 test/preload.ts 装配（bunfig [test].preload）。
// 约定：client 组件测试放组件旁边（*.test.tsx），只断 DOM 结构与行为钩子，不断样式。
//
// **入口不写 JSX**：Solid 2 只支持编译期 JSX——Bun 的 onLoad 插件对测试入口不生效，
// 入口里的 JSX 会走 Bun 内置的自动 runtime（React 风格 props），Solid 组件收不到
// class / 事件绑定。这里用 createComponent 代替 JSX（见 flow.harness.tsx 的说明）。
import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "@solidjs/web";
import { HandleView } from "@elysiax/flow";

test("HandleView 渲染连接点行为钩子", () => {
  const el = document.createElement("div");
  const dispose = render(
    () =>
      createComponent(HandleView, {
        type: "source",
        id: "src-1",
        title: "拖线起点",
      }),
    el,
  );
  const handle = el.querySelector("[data-handle-id='src-1']");
  expect(handle).not.toBeNull();
  expect(handle!.getAttribute("data-handle-type")).toBe("source");
  // data-nodrag 是拖拽系统的行为钩子：Handle 不触发节点拖拽
  expect(handle!.hasAttribute("data-nodrag")).toBe(true);
  dispose();
});
