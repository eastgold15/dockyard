/** @jsxImportSource solid-js */
/** 画布右键菜单门：把 Menu 状态同步到 Kobalte ContextMenu（定位/键盘/Esc/外部点击由 Kobalte 接管）。 */
import { createEffect } from "solid-js";
import { useContextMenuContext } from "@kobalte/core/context-menu";
import { useMenuContext } from "@kobalte/core/menu";
import type { Menu } from "./derive";
export function MenuGate(props: { state: () => Menu | null }) {
  const menuCtx = useMenuContext();
  const ctx = useContextMenuContext();
  createEffect(() => {
    const m = props.state();
    if (m) {
      ctx.setAnchorRect({ x: m.x, y: m.y });
      menuCtx.open(true);
    } else {
      menuCtx.close();
    }
  });
  return null;
}
