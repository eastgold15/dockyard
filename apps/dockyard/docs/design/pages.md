# Dockyard 页面设计进度表

> 每页四件事：现状源码差异 → 样板目标 → 实施 → 验收。状态只用：**未开始 / 待视觉验收 / 已验收**。
> “源码已改”不等于验收通过；验收必须在真实页面记录视口、日期与证据。
> 规范本体见 [../.interface-design/system.md](../.interface-design/system.md)。

## 状态图例

| 状态 | 含义 |
|---|---|
| 未开始 | 只登记了现状差异，没动手 |
| 待视觉验收 | 源码已按规范改造，需在浏览器里验收（启动项目须先询问用户） |
| 已验收 | 用户确认 + 视口/日期/证据已记录 |

## 页面清单

### servers（htmx，样板候选 #1）

**状态：待视觉验收（2026-10-26 部分实施，证据 /tmp/htmx-confirm.png、/tmp/htmx-modal.png，视口 1280×633）**

已实施：
- 共享资源弹窗迁移到 shared/ui `Modal`（lg 672px，遮罩 60% 黑 z-60、Esc/遮罩关闭、内容独立滚动）；
- 行内 hx-confirm 删除确认 → 全局样式化确认框（原生 `<dialog>` 单例 + htmx:confirm 拦截，行为对标 Kobalte AlertDialog）；
- 导航色源 neutral→harbor 统一（当前项 aria-current 待 layout 契约带路径后补）；
- 全局 toast 样式补齐（此前 #toast-root 无样式，toast 一直是裸 div）；responseError 弹服务端 `{error}` 文本。

仍待做：添加表单/TrustPrompt 细节规格、aria-current、语义 token 落 global.css。

现状差异（来自源码审查，非浏览器验收）：

- 列表行已用 48px 高、名称/主机/状态/操作四段式，基本符合规范方向；
- 添加表单与页面顶部的“添加服务器”按钮用内联黄铜实底类（`bg-brass-500 px-3 py-1.5`）而没走 `Button` 组件，与共享渲染件重复；
- `TrustPrompt` 用 `bg-brass-500/5 + border-brass-600/40` 整段提示——符合“警告淡底”角色，待样板时确认为警告提示的标准形态；
- 弹窗 `Modal`（共享资源）在 partials 内私有，宽 `36rem`、阴影 `shadow-2xl`、圆角 `rounded`，与规范目标（480px / 8px / 轻量阴影）有差；
- 空态已有 `Empty` 组件，文案与下一步指引合格；
- 待样板范围：列表行、添加表单、信任提示、共享资源弹窗的规格统一 + 验收。

### projects（htmx，样板候选 #2）

**状态：待视觉验收（2026-10-26 部分实施：两个弹窗迁移到 shared/ui `Modal`，扫描目录 sm 384 / 新建项目 md 480；原生 alert 的 hx-on::response-error 已删，失败走全局 toast）**

现状差异：

- 列表行与 servers 同构（48px、hover、分段），方向一致；
- `EditorPicker` split-button 是自绘结构，待对齐按钮规格与焦点环；
- 两个弹窗（扫描目录 / 新建项目）各自内联实现，宽度 26rem/30rem、`shadow-2xl`、圆角 `rounded-lg`，与 servers 的 36rem `rounded` 弹窗已是第三种形态——弹窗规格统一是全局任务；
- 新建项目提交按钮含 htmx 加载态（`.htmx-request` + spinner），是全应用异步提交态的参考实现，待固化为规范中的提交按钮模式；
- 待做：弹窗形态统一、主操作唯一化（页面右上两个按钮同权）、验收。

### canvas（Solid 整页，例外页；2026-10-25 起语义升级为世界地图）

**状态：未开始（几何有业务约束，最后动）**

> 画布语义已反转：物理服务器卡全局唯一（本机/远程分区），项目只是过滤透镜。新增待验收项：透镜切换、分区线、项目徽章、透镜外建内容禁用。原差异条目仍有效：

现状差异：

- 工作条 56px（vs 列表页页头目标 64px）——按规范允许保留紧凑布局，待确认；
- 节点卡用 emoji（🖥 📦 🗄 ⛁ ▸）作类型标识——规范定为“暂不替换、待选统一图标来源”；
- 抽屉 `Drawer`（576px/50vw 上限缺失窄屏兜底）与弹窗 `Modal`（384px/42rem）在 `drawers.tsx` 内私有实现，待与全局弹层规格统一；
- `drawers.tsx` 内有未使用的 `inputCls`/`labelCls` 常量（内联类与常量并存），待清理；
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

### 全局层（app.layout + global.css + shared/ui）

**状态：未开始**

现状差异：

- 侧边导航用 `bg-neutral-900 / border-neutral-800`，而全局基座是 Harbor 色系——nav 与内容不同色源，是规范明确要收敛的第一处；
- 导航无当前项状态（无 `aria-current`、无选中底色）；
- 内嵌 CDN 的 htmx/idiomorph 脚本（jsdelivr），桌面离线/内网场景是外部依赖——非视觉项，但与“工具自包含”相关，待决策是否本地化；
- `global.css` 的 `@theme` 只定义了 9 个颜色原语，语义 token（surface/border/text 层级）未定义——样板页实施时一次补齐；
- `shared/ui` 已有 Button/Badge/PageHeader/Field/Empty/Modal 六件（2026-10-26 Modal 入库，宽三档 sm/md/lg，htmx 三个私有弹窗已迁移）；Drawer/SubmitBtn 仍在画布私有。

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

（暂无——尚未有任何页面进入待视觉验收。每次验收在此追加一行：页面、日期、视口、证据路径、确认人。）
