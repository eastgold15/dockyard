# Dockyard 页面设计进度表

> 每页四件事：现状源码差异 → 样板目标 → 实施 → 验收。状态只用：**未开始 / 待视觉验收 / 已验收**。
> “源码已改”不等于验收通过；验收必须在真实页面记录视口、日期与证据。
> 规范本体见 [../../../dockyard/.interface-design/system.md](../../../dockyard/.interface-design/system.md)。

## 状态图例

| 状态 | 含义 |
|---|---|
| 未开始 | 只登记了现状差异，没动手 |
| 待视觉验收 | 源码已按规范改造，需在浏览器里验收（启动项目须先询问用户） |
| 已验收 | 用户确认 + 视口/日期/证据已记录 |

## 页面清单

### servers（htmx，样板候选 #1）

**状态：待视觉验收（2026-10-26 起局部实施；早期临时截图不作为持久验收证据）**

已实施：
- 共享资源弹窗迁移到 shared/ui `Modal`（lg 672px，遮罩 60% 黑 z-60、Esc/遮罩关闭、内容独立滚动）；
- 行内 hx-confirm 删除确认 → 全局样式化确认框（原生 `<dialog>` 单例 + htmx:confirm 拦截，行为对标 Kobalte AlertDialog）；
- 导航色源 neutral→harbor 统一（当前项 aria-current 待 layout 契约带路径后补）；
- 全局 toast 样式补齐（此前 #toast-root 无样式，toast 一直是裸 div）；responseError 弹服务端 `{error}` 文本。

仍待做：aria-current（需 layout 契约提供当前路径）、完整浏览器视觉验收。2026-11-05 第二轮已把添加服务器主按钮、镜像源按钮、select/textarea、共享资源徽章接入共享控件/Panda recipe，列表行与表单补 390px 换行和单列布局；TrustPrompt 保留警告淡底。

现状差异（来自源码审查，非浏览器验收）：

- 列表行已用 48px 高、名称/主机/状态/操作四段式，基本符合规范方向；
- 页面顶部的“添加服务器”按钮仍用内联黄铜实底类而没走 `Button` 组件；添加表单提交按钮已复用共享 `Button`；
- `TrustPrompt` 用 `bg-brass-500/5 + border-brass-600/40` 整段提示——符合“警告淡底”角色，待样板时确认为警告提示的标准形态；
- 共享资源弹窗已复用 shared/ui `Modal`，本轮将随共享容器接入 Panda；
- 空态已有 `Empty` 组件，文案与下一步指引合格；
- 待样板范围：列表行、添加表单、信任提示、共享资源弹窗的规格统一 + 验收。

### projects（htmx，样板候选 #2）

**状态：待视觉验收（2026-10-26 部分实施：两个弹窗迁移到 shared/ui `Modal`，扫描目录 sm 384 / 新建项目 md 480）**

现状差异：

- 列表行与 servers 同构（48px、hover、分段），方向一致；
- `EditorPicker` split-button 已改为 Panda ghost sm 按钮 + field 选择器，保留原有打开行为与错误提示；
- 两个弹窗（扫描目录 / 新建项目）已复用 shared/ui `Modal`，本轮将随共享容器接入 Panda，不再各自维护宽度和遮罩；
- 新建项目提交按钮含 htmx 加载态（`.htmx-request` + spinner），是全应用异步提交态的参考实现，待固化为规范中的提交按钮模式；
- 待做：完整浏览器验收。2026-11-05 第二轮已统一两个弹窗的输入/永久标签、提交加载态与主按钮，扫描目录降为次按钮，GitHub 创建保留唯一主操作；列表补长文本截断与窄屏 padding。
- 2026-11-05 错误反馈统一：elysiax `ServiceError` 对普通请求与 htmx 请求均返回 `{ error }` JSON，projects 的 3 处原生 `alert` 已删除，具体错误由全局 Toast 展示；`ValidationError` 仍保留 422 表单片段机制。源码已改，待浏览器验收。

### canvas（Solid 整页，例外页；2026-10-25 起语义升级为世界地图）

**状态：待视觉验收（已有 Kobalte 反馈、xterm 日志等局部实施；本轮 Panda 控件迁移仍需浏览器验收，几何模型不动）**

> 画布语义已反转：物理服务器卡全局唯一（本机/远程分区），项目只是过滤透镜。新增待验收项：透镜切换、分区线、项目徽章、透镜外建内容禁用。原差异条目仍有效：

现状差异：

- 工作条 56px（vs 列表页页头目标 64px）——按规范允许保留紧凑布局，待确认；
- 节点卡用 emoji（🖥 📦 🗄 ⛁ ▸）作类型标识——规范定为“暂不替换、待选统一图标来源”；
- 抽屉 `Drawer`（576px/50vw 上限缺失窄屏兜底）与弹窗 `Modal`（384px/42rem）在 `drawers.tsx` 内私有实现，待与全局弹层规格统一；
- `drawers.tsx` 的 `inputCls`/`labelCls` 常量被多处表单使用；它们尚未全部接入共享 Field，属于后续渐进迁移范围；
- 画布 24px 点阵、Brass 虚线依赖边、节点调色已符合方向，不动几何模型；
- 待做：弹层规格、图标策略、画布页视觉验收（拖动/缩放/连接/右键菜单/抽屉全状态）。

2026-10-26 部署功能完善新增待视觉验收项（源码已改，浏览器未验）：

- Deployments Tab：trigger 徽章（自动/回滚←#n）、每行「回滚」按钮（无快照置灰）、部署策略三态选择器（手动/仅提醒/自动）、本地导入 app 的「传输产物」按钮；
- 跨服务器拖拽迁移：命中另一台服务器卡触发 move 通道，跨界拒绝时 alert + 弹回原位（体验层预判，服务端兜底）。

2026-10-26 区域硬隔离补刀（源码已改，徽章已浏览器验，拖拽守卫未验）：

- servers 列表每行加「本机/远程」徽章（isLocalHost 回环地址派生，正主在 servers.socket）；
- 画布服务器卡跨区禁拖：本机卡不能进远程区（x≥0 拒绝）、远程卡不能进本机区——client 预判 alert 弹回 + 服务端 PATCH /nodes 422 兜底。

2026-10-26 画布交互反馈整改（源码已改，浏览器未验；回应用户"丑/瞬移/原生弹窗"三点批评）：

- 拖拽被拒改为**动画弹回起点**：flow NodeShell 非拖拽态 `left/top` 加 .25s 补间（拖拽中禁用），board 记录 dragOrigin、拒绝时 bounce——有意偏差：位移动效规范优先 transform/opacity，此处单节点低频弹回用 left/top 过渡，待验收确认观感与性能；
- 区域隔离从"坐标魔法线"重构为**车道模型**（`canvas/zones.ts` 单一事实源，用户批评"空气墙和背景不同步"后的重做）：中立带 ±24px，本机车道右缘钉 -GAP、远程车道左缘钉 +GAP；背景 tint 车道由卡片 bounds 派生、与墙读同一规则，不可能脱节；拖拽中按**卡片完整矩形**钳制，服务端 422 同规则裁决，右键建卡自动归位本车道；
- 画布 client 全面去原生弹窗：新建 `client/feedback.tsx`（Kobalte Dialog + Toast），alert→toast、confirm→confirmAction、prompt→promptAction，覆盖 board/drawers/nodes 全部 8 处。

2026-11-05 部署/服务日志改 xterm.js 只读视图（源码已改，浏览器未验）：

- 新增 `client/log-view.tsx` 可复用只读 `LogView`（xterm.js 渲染 ANSI，复用已有 `@xterm/xterm` + `@xterm/addon-fit`，不新增运行时依赖）；
- `drawers.tsx` 的 `DeployLogModal`（部署日志）与 `ServiceLogs`（服务日志）两处 `<pre>` 替换为 `LogView`，保留 HTTP 回填、SSE 增量与 2s 轮询数据流，不改服务端协议；高度按任务规格：部署约 24rem（h-96）、服务约 40vh；
- 增量策略：`props.text` 为完整日志，后续文本以旧文本为前缀时只 `term.write` 增量；run 切换/终态对齐/截断非前缀时清屏序列+正文同一次 write 完整替换，避开异步 reset/write 竞态；
- 错误/警告/成功行按 Harbor 色板套 ANSI 颜色（Signal 红 / Brass 黄 / Tide 绿），已有 ANSI 的行不套色、不改落库原文；
- 跟随策略：停在底部时自动跟随，向上翻阅不强制拉回，全文替换后回到底部；Terminal `disableStdin`/`convertEol`/Harbor 950 背景/12px 等宽/scrollback 5000，FitAddon + ResizeObserver，卸载 dispose。

2026-11-05 画布 client 剩余内联控件迁移（源码已改，浏览器未验；只消费已定义 recipe，不新增变体）：

- 节点卡内按钮全部接入共享 `button` recipe：部署 = `primary sm`（黄铜实底，卡内唯一主操作）；变量/域名/日志/连接串 = `ghost sm`；移除 ✕ 保留弱化（ghost 外壳 + 悬停才亮 Signal，避免与主按钮抢注意力）；全部补 `aria-label` 与 `nodrag`；
- 顶部工作条透镜选择器接入共享 `field` recipe（`w-auto` 布局例外，工具条右侧不占满行宽）；空态与工具条提示对比度提升（`neutral-500` → `neutral-400`）；
- 右键菜单：容器 `shadow-2xl` → `shadow-xl`（收敛重投影）；菜单项补 Brass 焦点环、禁用加 `opacity`、危险项 Signal 淡底 hover；
- 几何与行为不动：节点宽高/截断/几何常量未改，拖拽/缩放/连接/SSE/Kobalte Promise 反馈与业务协议未改；未引入原生 alert/confirm/prompt，无新依赖。

2026-11-05 右键菜单已迁移到 Kobalte `ContextMenu`：沿用 pane/server/group 上下文和既有业务动作，由 Kobalte 接管视口定位、键盘选择、Esc、外部点击与焦点管理，外观继续使用 Panda `menu` recipe；FlowView 回调只设置菜单上下文与锚点。源码已改，待浏览器验收。右键仍是部分建卡/分组操作的唯一入口，可见入口另列后续任务。

2026-11-05 drawers.tsx 第二轮 Panda 迁移（源码已改，浏览器未验）：删除 `inputCls`/`labelCls`；全部 input/select/textarea 走 `field()`（textarea 用 min-h 防固定高度裁切）；全部按钮走 `button` recipe；永久标签统一；失败徽章改 Signal；修复不存在的颜色类与控制台硬编码色。节点按钮升至 32px、列表行内动作按钮化后的密度，以及 390px 窄屏仍待验收。

### 全局层（app.layout + global.css + shared/ui）

**状态：待视觉验收（导航、确认框、Toast 与本轮 Panda 共享样式均有局部源码实施）**

现状差异：

- 侧边导航已使用 Harbor 色源，与全局基座一致；
- 导航无当前项状态（无 `aria-current`、无选中底色）；
- 内嵌 CDN 的 htmx/idiomorph 脚本（jsdelivr），桌面离线/内网场景是外部依赖——非视觉项，但与“工具自包含”相关，待决策是否本地化；
- `global.css` 保留 Tailwind 颜色原语与布局工具；Button/Field/Badge/Modal/Drawer/Menu 的 token 与 recipe 由 Panda 统一维护；第二轮已迁移 servers、projects、Canvas 的剩余主要内联按钮、表单控件与状态徽章，仍待浏览器验收；
- `shared/ui` 已有 Button/Badge/PageHeader/Field/Empty/Modal 六件；第二轮扩展 Button/Field 的向后兼容 props，页头采用 64px 最小高与窄屏换行；Drawer/SubmitBtn 仍在画布私有，只共享 Panda 样式，不抽取跨运行时组件。
- 2026-11-05 导航补键盘焦点、44px 命中区与窄屏折叠入口；折叠使用原生 hidden 显示态，#main 外层布局避免 htmx 替换导航。当前项 aria-current 仍需 layout 提供路径后补。

2026-11-05 Panda 第一轮迁移（**源码已改，待用户验证与视觉验收**）：

- 新增 `panda.config.ts` 与 `panda/recipes.ts`，显式启用 Panda v2 `preset-base`、关闭 preflight，并为 Button、Field、Badge、Modal、Drawer 声明静态完整变体；
- htmx 的 shared/ui 与全局确认框、Solid 的 drawers/feedback/nodes 已改为消费同一组生成 recipe；保留各自 DOM 所有权、组件 props、Kobalte Promise 反馈和现有弹层行为；
- 删除 `shadcn-htmx.json` 与 10 个静态 snippets；Tailwind 布局类与未纳入本轮的控件保留；
- 最后配置修正后的代码生成、typecheck、测试、构建、doctor 和浏览器验收均由用户执行，当前不登记为通过。重点验收 servers、projects、Canvas，以及 390px 窄屏、键盘焦点和弹层尺寸。

### 其他

| 页面 | 状态 | 备注 |
|---|---|---|
| index | 未开始 | 纯 302 重定向，无视觉面 |
| ping | 未开始 | 测试页，原生按钮无样式；不纳入正式设计范围，但不允许作为新页面样式参考 |

## 待办全局任务（按序）

1. **样板 = servers**：语义 token 落 `global.css`、nav 色源统一、Button/弹窗规格收敛、信任提示定型 → 待视觉验收 → 用户确认 → 冻结。
2. 冻结后扩展到 projects（弹窗统一 + split-button）。
3. 最后 canvas（弹层 + 图标 + 例外边界验收）。
4. 图标来源统一选型（替换 emoji）单独决策，不混进样板。

## 验收记录

（暂无有效记录。早期 `/tmp` 截图路径不作为持久验收证据；每次验收在此追加一行：页面、日期、视口、稳定证据路径、确认人。）
