/** @jsxImportSource @solidjs/web */
/**
 * flow 包的测试夹具：JSX 放在**被导入的**模块里。
 *
 * 为什么不能写在测试入口（*.test.tsx）里：Solid 2 只支持编译期 JSX——
 * Bun 的 onLoad 插件对测试入口不生效（实测），入口里的 JSX 会走 Bun 内置的
 * 自动 runtime（React 风格 props），Solid 组件收不到 class / 事件绑定，
 * 表现为「元素渲染出来了但点不动」。
 *
 * 规矩：**测试入口写纯 TS 调用，JSX 放进被导入的 .tsx**（它会被 babel + 编译器编译）。
 */
import { FlowView, Resizer, type FlowViewProps, type NodeViewProps } from "@elysiax/flow";
import type { JSX } from "@solidjs/web";

export interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: unknown;
  width?: number;
  height?: number;
  selected?: boolean;
}

/** FlowView 需要 pointer capture；happy-dom 未实现时补一个空实现 */
export const ensureCapture = (): void => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
};

/** 普通节点视图 */
export const boxView = (p: NodeViewProps<never>) => (
  <div class="box">{p.id}</div>
);

/** 带拉伸手柄的节点视图 */
export const resizeView = (p: NodeViewProps<never>) => (
  <div class="box">
    <Resizer
      nodeId={p.id}
      visible
      minW={10}
      minH={10}
      width={p.width ?? 100}
      height={p.height ?? 100}
      onEnd={() => {}}
    />
  </div>
);

/**
 * FlowView 的非泛型包装：FlowViewProps<N> 是泛型的，测试入口用 createComponent
 * 调用它时类型对不上（Component<Record<string, any>> vs 具体 props）。
 * 这里把 props 收敛成测试用到的具体形状，入口只需 createComponent(FlowHarness, …)。
 */
export function FlowHarness(props: {
  nodes: FlowNode[];
  nodeViews: Record<string, (p: NodeViewProps<never>) => JSX.Element>;
  onNodeMove?: (id: string, pos: { x: number; y: number }) => void;
  onNodeDragStop?: (node: FlowNode, cancelled?: boolean) => void;
  onNodeResize?: (id: string, w: number, h: number, resizing: boolean) => void;
  onNodeResizeEnd?: (id: string, w: number, h: number) => void;
}): JSX.Element {
  const view = props as unknown as FlowViewProps<FlowNode>;
  return (
    <FlowView
      nodes={view.nodes}
      edges={view.edges ?? []}
      nodeViews={view.nodeViews as FlowViewProps<FlowNode>["nodeViews"]}
      onNodeMove={view.onNodeMove ?? (() => {})}
      onNodeDragStop={view.onNodeDragStop}
      onNodeResize={view.onNodeResize}
      onNodeResizeEnd={view.onNodeResizeEnd}
    />
  );
}
