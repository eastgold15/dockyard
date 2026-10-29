/** @jsxImportSource solid-js */
// 遮罩关闭契约：必须「按下与松开都在遮罩上」才关。
// 两个方向都会让 click 派发到公共祖先（遮罩）：
// - 面板内按下、拖到遮罩松手（拖选文本）
// - 遮罩按下、拖进面板松手
// 只比 click.target 的写法会在两种情况下都误关，把用户正在编辑的内容丢掉。
import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { Drawer, Modal } from "./drawers";

function mountShell(kind: "modal" | "drawer") {
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

const down = (el: Element, pointerId = 1) =>
  el.dispatchEvent(new PointerEvent("pointerdown", { pointerId, bubbles: true, cancelable: true }));
const up = (el: Element, pointerId = 1) =>
  el.dispatchEvent(new PointerEvent("pointerup", { pointerId, bubbles: true, cancelable: true }));
const cancel = (el: Element, pointerId = 1) =>
  el.dispatchEvent(new PointerEvent("pointercancel", { pointerId, bubbles: true, cancelable: true }));
// click 的 target 永远是遮罩（公共祖先），模拟浏览器把 click 派发到公共祖先
const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

for (const kind of ["modal", "drawer"] as const) {
  test(`${kind}：按下与松开都在遮罩上才关闭`, () => {
    const h = mountShell(kind);
    down(h.overlay);
    up(h.overlay);
    click(h.overlay);
    expect(h.closed()).toBe(1);
    h.dispose();
  });

  test(`${kind}：面板内按下、在遮罩上松开不关闭（拖选文本）`, () => {
    const h = mountShell(kind);
    down(h.panel);
    up(h.overlay);
    click(h.overlay);
    expect(h.closed()).toBe(0);
    h.dispose();
  });

  test(`${kind}：遮罩上按下、拖进面板松开不关闭`, () => {
    const h = mountShell(kind);
    down(h.overlay);
    up(h.panel);
    click(h.overlay);
    expect(h.closed()).toBe(0);
    // 下一次完整点遮罩恢复关闭能力（状态不是一次性的）
    down(h.overlay);
    up(h.overlay);
    click(h.overlay);
    expect(h.closed()).toBe(1);
    h.dispose();
  });

  test(`${kind}：多指按下互不覆盖——按在面板上的指头在遮罩上松开不算关闭`, () => {
    const h = mountShell(kind);
    down(h.panel, 1); // 指头 1 按在面板里
    down(h.overlay, 2); // 指头 2 按在遮罩上
    up(h.overlay, 1); // 指头 1 拖到遮罩上松手：它没按在遮罩上，不能关
    click(h.overlay);
    expect(h.closed()).toBe(0);
    // 指头 2 仍在按下状态：它在遮罩上松手后才是合法点击
    up(h.overlay, 2);
    click(h.overlay);
    expect(h.closed()).toBe(1);
    h.dispose();
  });

  test(`${kind}：pointercancel 复位按下意图（手势被系统夺走不算点击）`, () => {
    const h = mountShell(kind);
    // 先制造一次「松开在遮罩、click 却落在面板」的残留意图：click 因 target 不符提前返回，
    // 该意图不会被消费（真实场景：遮罩按下后拖进面板松手，落到面板里的按钮上）
    down(h.overlay, 1);
    up(h.overlay, 1);
    click(h.panel);
    expect(h.closed()).toBe(0);
    // 新一次按下遮罩、被系统取消（滚动/来电打断）：残留意图必须一起作废，
    // 否则随后到达的 click（不跟随 pointerup 派发）会拿旧意图关掉弹窗
    down(h.overlay, 2);
    cancel(h.overlay, 2);
    click(h.overlay);
    expect(h.closed()).toBe(0);
    // 取消只复位那根指针：重新完整点击仍可关闭
    down(h.overlay, 2);
    up(h.overlay, 2);
    click(h.overlay);
    expect(h.closed()).toBe(1);
    h.dispose();
  });
}
