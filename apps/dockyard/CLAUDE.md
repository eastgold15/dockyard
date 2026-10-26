## Dockyard

## UI - 设计规范（先读）

任何 UI 任务（新页面、改样式、加组件、视觉审查）开始前，先读：

1. `.interface-design/system.md` — 视觉契约：颜色/排版/间距/组件规格/例外边界
2. `docs/design/pages.md` — 页面进度表：现状差异、实施状态、验收记录

规范没有覆盖到的新模式：先与用户确认，确认后同步更新 system.md 与 pages.md。不得仅凭本轮对话记忆另起风格。状态纪律：文档已写 ≠ 源码已改 ≠ 浏览器验收通过；进度表只认三态（未开始 / 待视觉验收 / 已验收）。

## UI - shadcn-htmx

UI 组件优先用 shadcn-htmx（htmx v4 + Tailwind v4，flavour=html）。组件清单用 `bunx shadcn-htmx list` 现查，添加用 `bunx shadcn-htmx add <组件>`；registry 配置见 `shadcn-htmx.json`。





## 依赖优先原则
实现任何通用功能前，必须先检查是否有现成的成熟库可用：
1. 先查 package.json 已有依赖能否满足
2. 再评估 npm 上的主流包（周下载量、维护状态），优先用 Context7 查其文档；UI/组件类需求优先选所用框架官方生态的库（Solid → Kobalte，对标 React 的 Radix），禁止手写弹层、焦点管理、可访问性原语
3. 只有确认现成方案不满足需求时才手写实现，并在回复中说明为什么不用现成库
通用功能包括但不限于：日期处理、校验、ID 生成、重试/限流、文件监听、CLI 解析、日志等。




不要让 htmx 和 Solid 操作同一个 DOM 元素。画布已是整页 Solid client 模式（src/pages/canvas/client/），/canvas 由壳 HTMLBundle 服务、不走 htmx；htmx 页面（servers/projects）与 Solid 页天然隔离，不存在共享 DOM。client 代码依赖链禁 Node-only 包（dotenv/bun:sqlite → 浏览器打包 500）。

错误处理约定：services 抛 ServiceError（@elysiax/core），actions 不写 try/catch 回显；预期错误 return status(code, { error })。

进行测试，需要询问我