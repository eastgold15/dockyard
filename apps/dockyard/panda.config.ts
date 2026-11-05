import { defineConfig } from "@pandacss/dev";
import { badge, button, drawer, field, menu, modal } from "./panda/recipes";

/**
 * Panda CSS 最小迁移配置。
 * - presets：Panda v2 默认 presets=[]，必须带 preset-base 才有基础 utilities/conditions
 *   （短 token 引用、_hover/_focusVisible/_disabled 等伪类才能被正确编译）；不引入
 *   preset-panda，我们自带所需色板。
 * - preflight false：基础 reset 由 Tailwind（global.css）负责，两套不叠。
 * - outdir styled-system：生成物在 apps/dockyard/styled-system，两侧（htmx 服务端 + Solid 画布）
 *   以相对路径 import recipe 函数，运行时只产生 className 字符串，无样式 JSX。
 * - theme 只定义配色原语与共享 recipe/slotRecipe；配色值来自 global.css @theme 与设计规范，
 *   不在页面里复制主题。
 * - staticCss.recipes 为全部共享 recipe 声明完整变体：Solid 侧存在运行时
 *   tone()/wide 三元等动态值，静态提取覆盖不到，必须预生成。
 */
export default defineConfig({
  presets: ["@pandacss/preset-base"],
  preflight: false,
  include: ["./src/**/*.{ts,tsx}"],
  exclude: [],
  outdir: "styled-system",
  theme: {
    extend: {
      tokens: {
        colors: {
          harbor: {
            950: { value: "#0b0f14" },
            900: { value: "#11161d" },
            800: { value: "#1a222c" },
            700: { value: "#243040" },
            600: { value: "#33445a" },
          },
          brass: {
            500: { value: "#d9a441" },
            600: { value: "#b98a2f" },
          },
          tide: {
            400: { value: "#5ec4b6" },
          },
          signal: {
            500: { value: "#d95d4e" },
          },
          neutral: {
            100: { value: "#f5f5f5" },
            200: { value: "#e5e5e5" },
            300: { value: "#d4d4d4" },
            400: { value: "#a3a3a3" },
            500: { value: "#737373" },
            600: { value: "#525252" },
            700: { value: "#404040" },
          },
        },
      },
      recipes: { button, field, badge },
      slotRecipes: { modal, drawer, menu },
    },
  },
  staticCss: {
    recipes: {
      button: ["*"],
      field: ["*"],
      badge: ["*"],
      modal: ["*"],
      drawer: ["*"],
      menu: ["*"],
    },
  },
});
