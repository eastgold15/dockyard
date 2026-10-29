/** @jsxImportSource solid-js */
// 遮罩关闭契约：必须「按下与松开都在遮罩上」才关。
// 从面板里拖选文本、拖到遮罩上松手时，浏览器把 click 派发给公共祖先（遮罩）——
// 只比 click.target 的写法会误关弹窗，把用户正在编辑的内容丢掉。
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
  // 遮罩 = 根节点（fixed inset-0），面板 = 它下面带 max-h 的第一层
  const overlay = el.firstElementChild as HTMLElement;
  const inner = el.querySelector(".inner") as HTMLElement;
  return { el, overlay, inner, closed: () => closed, dispose: () => { dispose(); el.remove(); } };
}

const down = (el: Element) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

for (const kind of ["modal", "drawer"] as const) {
  test(`${kind}：按下与松开都在遮罩上才关闭`, () => {
    const h = mountShell(kind);
    down(h.overlay);
    click(h.overlay);
    expect(h.closed()).toBe(1);
    h.dispose();
  });

  test(`${kind}：从面板内按下、在遮罩上松开不关闭（拖选文本的 click 落在公共祖先）`, () => {
    const h = mountShell(kind);
    down(h.inner);
    click(h.overlay);
    expect(h.closed()).toBe(0);
    // 下一次从遮罩按下才恢复关闭能力（状态不是一次性的）
    down(h.overlay);
    click(h.overlay);
    expect(h.closed()).toBe(1);
    h.dispose();
  });
}
