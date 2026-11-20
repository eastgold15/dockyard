/** @jsxImportSource @solidjs/web */
/**
 * 弹层挂载夹具：把 Modal / Drawer 的 JSX 放在**被导入的**模块里。
 *
 * 为什么不能写在测试入口（*.test.tsx）里：Solid 2 只支持编译期 JSX——
 * Bun 的 onLoad 插件对测试入口不生效（实测），入口里的 JSX 会走 Bun 内置的
 * 自动 runtime → 解析 @solidjs/web/jsx-runtime，而 Solid 2 的该导出只带类型
 * （运行时无 jsx 实现），报 "Export named 'jsx' not found"。
 *
 * 规矩：**测试入口写纯 TS 调用，JSX 放进被导入的 .tsx**（它会被 babel 编译）。
 */
import { render } from "@solidjs/web";
import { Drawer, Modal } from "./index";

export interface ShellHarness {
  overlay: HTMLElement;
  panel: HTMLElement;
  closed: () => number;
  dispose: () => void;
}

/** 挂一个弹层到 detached 容器，返回遮罩/面板/关闭计数 */
export function mountShell(kind: "modal" | "drawer"): ShellHarness {
  let closed = 0;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const dispose = render(
    () =>
      kind === "modal" ? (
        <Modal title="测试" onClose={() => closed++}>
          <p class="inner">内容</p>
        </Modal>
      ) : (
        <Drawer title="测试" onClose={() => closed++}>
          <p class="inner">内容</p>
        </Drawer>
      ),
    el,
  );
  // 钩子由组件提供（data-shell），不依赖「根节点一定是遮罩」这种未声明的结构约定
  const overlay = el.querySelector("[data-shell='overlay']") as HTMLElement;
  const panel = el.querySelector("[data-shell='panel']") as HTMLElement;
  return {
    overlay,
    panel,
    closed: () => closed,
    dispose: () => {
      dispose();
      el.remove();
    },
  };
}
