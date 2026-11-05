import { defineRecipe, defineSlotRecipe } from "@pandacss/dev";

/**
 * Dockyard 视觉契约（.interface-design/system.md）的 Panda recipe 实现。
 * 配色只用 Harbor / Brass / Tide / Signal 原语 + neutral 文字层级；
 * 尺寸按规范：控件 36/32px、弹窗 384/480/672、抽屉 576/768、遮罩 60%、z-60。
 * htmx（shared/ui / app.layout）与 Solid（canvas client）共享本组 recipe，运行时隔离。
 *
 * token 引用规则（Panda 有效语法）：
 * - 单色值：短 token `harbor.950` / `brass.500`（不要写 `colors.` 前缀）
 * - 带透明度：`signal.500/10`
 * - 复合值（border/outline/boxShadow）：花括号 `{colors.harbor.700}`
 * - padding 用标准属性 paddingLeft/Right/Top/Bottom，不写 paddingX/Y
 */

/** 主/次/危险按钮：36px（md）/ 32px（sm），键盘焦点统一 Brass 外环 */
export const button = defineRecipe({
  className: "button",
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "4px",
    transitionProperty: "color, background-color, border-color",
    transitionDuration: "150ms",
    transitionTimingFunction: "ease",
    _focusVisible: {
      outline: "2px solid {colors.brass.500}",
      outlineOffset: "2px",
    },
    _disabled: {
      opacity: "0.7",
      pointerEvents: "none",
    },
  },
  variants: {
    variant: {
      primary: {
        background: "brass.500",
        color: "harbor.950",
        fontWeight: "600",
        _hover: { background: "brass.600" },
      },
      // secondary 角色的次按钮：Harbor 边框/表面，不另造强调色
      ghost: {
        border: "1px solid {colors.harbor.700}",
        color: "neutral.400",
        fontWeight: "500",
        _hover: { background: "harbor.800", color: "neutral.200" },
      },
      danger: {
        color: "signal.500",
        fontWeight: "600",
        border: "1px solid transparent",
        _hover: { background: "signal.500/10" },
      },
    },
    size: {
      md: { height: "36px", paddingLeft: "12px", paddingRight: "12px", fontSize: "14px" },
      sm: { height: "32px", paddingLeft: "8px", paddingRight: "8px", fontSize: "12px" },
    },
  },
  defaultVariants: { variant: "primary", size: "md" },
});

/** 表单输入：Harbor 950 内凹底 + Harbor 700 边框；键盘焦点 Brass 外环，不只换红边框 */
export const field = defineRecipe({
  className: "field",
  base: {
    width: "100%",
    height: "36px",
    paddingLeft: "10px",
    paddingRight: "10px",
    fontSize: "14px",
    borderRadius: "4px",
    background: "harbor.950",
    border: "1px solid {colors.harbor.700}",
    color: "neutral.200",
    outline: "none",
    transitionProperty: "border-color, outline, outline-offset",
    transitionDuration: "150ms",
    _placeholder: { color: "neutral.600" },
    _focusVisible: {
      borderColor: "brass.500",
      outline: "2px solid {colors.brass.500}",
      outlineOffset: "2px",
    },
    _disabled: { opacity: "0.5", cursor: "not-allowed" },
  },
});

/** 状态徽章：11px/500、淡底 + 文字，状态点只是辅助 */
export const badge = defineRecipe({
  className: "badge",
  base: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: "4px",
    paddingLeft: "6px",
    paddingRight: "6px",
    paddingTop: "2px",
    paddingBottom: "2px",
    fontSize: "11px",
    fontWeight: "500",
    fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace",
  },
  variants: {
    tone: {
      ok: { background: "tide.400/10", color: "tide.400" },
      warn: { background: "brass.500/15", color: "brass.500" },
      err: { background: "signal.500/15", color: "signal.500" },
      muted: { background: "harbor.800", color: "neutral.500" },
    },
  },
  defaultVariants: { tone: "muted" },
});

/** 浮层菜单：面板与菜单项共享 Harbor 层级、Brass 焦点和 Signal 危险态；行为仍由现有组件负责。 */
export const menu = defineSlotRecipe({
  className: "menu",
  slots: ["panel", "item"],
  base: {
    panel: {
      minWidth: "160px",
      paddingTop: "4px",
      paddingBottom: "4px",
      borderRadius: "4px",
      border: "1px solid {colors.harbor.700}",
      background: "harbor.900",
      boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
    },
    item: {
      display: "block",
      width: "100%",
      paddingLeft: "12px",
      paddingRight: "12px",
      paddingTop: "6px",
      paddingBottom: "6px",
      textAlign: "left",
      fontSize: "14px",
      color: "neutral.200",
      _hover: { background: "harbor.800" },
      _focusVisible: {
        outline: "2px solid {colors.brass.500}",
        outlineOffset: "-2px",
      },
      _disabled: { color: "neutral.500", opacity: "0.6", cursor: "not-allowed" },
    },
  },
  variants: {
    tone: {
      default: {},
      danger: { item: { color: "signal.500", _hover: { background: "signal.500/10" } } },
    },
  },
  defaultVariants: { tone: "default" },
});

/** 模态弹窗：遮罩 60% 黑、z-60、圆角 8px、宽三档 sm 384 / md 480 / lg 672、内容 ≤85vh 独立滚动。
 *   header 自带 20/16 padding 与底边框，与 Drawer 一致，调用方不再补差异。 */
export const modal = defineSlotRecipe({
  className: "modal",
  slots: ["overlay", "panel", "header", "title", "sub", "close", "body"],
  base: {
    overlay: {
      position: "fixed",
      inset: "0",
      zIndex: "60",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px",
      background: "rgba(0,0,0,0.6)",
      outline: "none",
    },
    panel: {
      display: "flex",
      flexDirection: "column",
      width: "480px",
      maxWidth: "100%",
      maxHeight: "85vh",
      borderRadius: "8px",
      border: "1px solid {colors.harbor.700}",
      background: "harbor.900",
      boxShadow: "0 10px 40px rgba(0,0,0,0.4)",
      outline: "none",
    },
    header: {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: "8px",
      paddingLeft: "20px",
      paddingRight: "20px",
      paddingTop: "16px",
      paddingBottom: "16px",
      borderBottom: "1px solid {colors.harbor.800}",
    },
    title: { fontSize: "14px", fontWeight: "600", color: "neutral.100" },
    sub: { fontSize: "12px", color: "neutral.500" },
    close: {
      color: "neutral.500",
      _hover: { color: "neutral.200" },
      _focusVisible: {
        outline: "2px solid {colors.brass.500}",
        outlineOffset: "2px",
      },
    },
    body: { flex: "1", minHeight: "0", overflowY: "auto" },
  },
  variants: {
    width: {
      sm: { panel: { width: "384px" } },
      md: { panel: { width: "480px" } },
      lg: { panel: { width: "672px" } },
    },
  },
  defaultVariants: { width: "md" },
});

/** 右侧抽屉：默认 576px、宽 768px，窄屏全宽（maxWidth 100% 兜底）、遮罩 60%、z-60 */
export const drawer = defineSlotRecipe({
  className: "drawer",
  slots: ["overlay", "panel", "header", "title", "sub", "close", "body"],
  base: {
    overlay: {
      position: "fixed",
      inset: "0",
      zIndex: "60",
      background: "rgba(0,0,0,0.6)",
    },
    panel: {
      position: "fixed",
      top: "0",
      right: "0",
      bottom: "0",
      left: "auto",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      width: "576px",
      maxWidth: "100%",
      borderLeft: "1px solid {colors.harbor.700}",
      background: "harbor.900",
      boxShadow: "0 10px 40px rgba(0,0,0,0.4)",
      outline: "none",
    },
    header: {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: "8px",
      paddingLeft: "20px",
      paddingRight: "20px",
      paddingTop: "16px",
      paddingBottom: "16px",
      borderBottom: "1px solid {colors.harbor.800}",
    },
    title: { fontSize: "14px", fontWeight: "600", color: "neutral.100" },
    sub: { fontSize: "12px", color: "neutral.500" },
    close: {
      color: "neutral.500",
      _hover: { color: "neutral.200" },
      _focusVisible: {
        outline: "2px solid {colors.brass.500}",
        outlineOffset: "2px",
      },
    },
    body: {
      flex: "1",
      overflowY: "auto",
      paddingLeft: "20px",
      paddingRight: "20px",
      paddingTop: "16px",
      paddingBottom: "16px",
    },
  },
  variants: {
    width: {
      md: { panel: { width: "576px" } },
      lg: { panel: { width: "768px" } },
    },
  },
  defaultVariants: { width: "md" },
});
