/**
 * 画布 client 的 UI 总线：抽屉/弹窗的开合 + 结构刷新（Solid 版）。
 * Solid 的 context/useContext 与 React 语义一致，只是 provider 值是稳定引用、
 * 细粒度订阅发生在 JSX 读取处。
 */
import { createContext, useContext } from "solid-js";
import type { DiscoveredContainer } from "../canvas.model";

/** 模态视图描述：App 层的 DrawerHost 按 kind 渲染对应抽屉 */
export type View =
  // projectId = 当前透镜：服务端据此判定来源形态（local / github）
  | { kind: "new-app"; nodeId: number; projectId?: number | null }
  // projectId = 当前透镜：新建实例必须带项目归属，否则透镜过滤后卡片立即消失
  | { kind: "new-db"; nodeId: number; projectId?: number | null }
  | { kind: "service"; targetId: number; svc?: string; tab?: string }
  | { kind: "env"; targetId: number }
  | { kind: "domains"; targetId: number }
  | { kind: "log"; targetId: number; dep?: number }
  // 发现容器（只读）：卡片数据已在 /board 快照里，无需再拉接口
  | { kind: "discovered"; d: DiscoveredContainer };

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
