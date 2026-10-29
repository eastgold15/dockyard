/** @jsxImportSource solid-js */
// 拖拽收尾契约：pointercancel（手势被系统夺走）必须走 onNodeDragStop(node, true)，
// 调用方才能回滚位置并放开门闩。只清内部状态的写法会让画布永久冻结。
import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { FlowView, type NodeViewProps } from "@elysiax/flow";

interface N { id: string; type: string; position: { x: number; y: number }; data: unknown }

const nodeViews = {
  box: (p: NodeViewProps<never>) => <div class="box">{p.id}</div>,
} as unknown as Record<string, (p: NodeViewProps<never>) => Element>;

/** FlowView 需要 pointer capture；happy-dom 未实现时补一个空实现 */
const ensureCapture = () => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
};

function mount(onStop: (n: N, cancelled?: boolean) => void) {
  ensureCapture();
  const nodes: N[] = [{ id: "n1", type: "box", position: { x: 0, y: 0 }, data: {} }];
  // 必须挂进 document：Solid 的指针事件是文档级委托，脱离文档的元素收不到
  const el = document.createElement("div");
  document.body.appendChild(el);
  const dispose = render(
    () => (
      <FlowView
        nodes={nodes}
        edges={[]}
        nodeViews={nodeViews}
        onNodeMove={() => {}}
        onNodeDragStop={onStop as never}
      />
    ),
    el,
  );
  return {
    el,
    dispose: () => {
      dispose();
      el.remove();
    },
  };
}

const fire = (el: Element, type: string, pointerId: number) =>
  el.dispatchEvent(new PointerEvent(type, { pointerId, button: 0, bubbles: true, cancelable: true }));

test("pointercancel 上报 dragStop(cancelled=true)，正常松手为 false/undefined", () => {
  const calls: { id: string; cancelled: boolean | undefined }[] = [];
  const { el, dispose } = mount((n, cancelled) => calls.push({ id: n.id, cancelled }));

  const node = el.querySelector(".flow-node")!;
  fire(node, "pointerdown", 1);
  fire(node, "pointercancel", 1);
  expect(calls).toEqual([{ id: "n1", cancelled: true }]);

  // 正常松手：cancelled 缺省
  fire(node, "pointerdown", 2);
  fire(node, "pointerup", 2);
  expect(calls).toEqual([
    { id: "n1", cancelled: true },
    { id: "n1", cancelled: undefined },
  ]);
  dispose();
});

test("非 owner 指针的取消不影响当前拖拽（第二根指头抬起不结束第一根的手势）", () => {
  const calls: unknown[] = [];
  const { el, dispose } = mount((n, cancelled) => calls.push([n.id, cancelled]));

  const node = el.querySelector(".flow-node")!;
  fire(node, "pointerdown", 1);
  fire(node, "pointercancel", 2); // 别人的取消
  expect(calls).toEqual([]);
  fire(node, "pointerup", 1);
  expect(calls).toEqual([["n1", undefined]]);
  dispose();
});
