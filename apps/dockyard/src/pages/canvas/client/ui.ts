/**
 * 画布 client 的 UI 总线：抽屉/弹窗的开合 + 结构刷新（Solid 版）。
 * Solid 的 context/useContext 与 React 语义一致，只是 provider 值是稳定引用、
 * 细粒度订阅发生在 JSX 读取处。
 */
import { createContext, useContext } from "solid-js";

/** 模态视图描述：App 层的 DrawerHost 按 kind 渲染对应抽屉 */
export type View =
  | { kind: "new-app"; nodeId: number }
  | { kind: "new-db"; nodeId: number }
  | { kind: "service"; targetId: number; svc?: string; tab?: string }
  | { kind: "env"; targetId: number }
  | { kind: "domains"; targetId: number }
  | { kind: "log"; targetId: number; dep?: number };

export interface UiBus {
  open(view: View): void;
  close(): void;
  /** 结构变更（建/删卡、建/删边、域名）→ 画布重拉 */
  refresh(): void;
}

export const UiContext = createContext<UiBus>({
  open: () => {},
  close: () => {},
  refresh: () => {},
});

export const useUi = () => useContext(UiContext);

/** 结构刷新约定：board.tsx 监听 body 的 refresh 事件 */
export const emitRefresh = () => document.body.dispatchEvent(new Event("refresh"));
