# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库结构

Bun workspace + Turborepo，两个应用：

- `apps/dockyard` —— 主应用（Bun + Elysia + elysiax 原子架构）。目录级约束在 `apps/dockyard/CLAUDE.md`，在其中工作时同样生效。
- `apps/docs` —— Blume 文档站。文档统一放 `apps/docs/docs/`，不散落在别处。

框架（elysiax）通过 `link:../../../elysiax/packages/*` 指向同级仓库 `~/Documents/GitHub/elysiax`（不是 npm 包）。改框架行为需要两个仓库一起改；框架文档在 elysiax 仓库的 `apps/docs/docs/`。

## 常用命令

根目录（Turbo 转发）：

```sh
bun install
bun run dev        # turbo run dev
bun run build
bun run typecheck
```

以下命令在 `apps/dockyard` 下执行：

```sh
bun run dev                      # css:panda + elysiax dev（codegen + 热更新）
bun run typecheck                # 先 gen（Panda + elysiax codegen）再 tsc --noEmit
bun test --conditions=browser                                   # 全量测试（bunfig 已预载 happy-dom）
bun test --conditions=browser src/pages/deploy/pipeline.test.ts # 单文件
bun test --conditions=browser -t "用例名关键字"                   # 按用例名过滤
bun run css:panda                # 改 panda.config.ts / panda/recipes.ts 后必跑
bun run panda:watch              # 开发期监听重新生成 CSS
bunx elysiax doctor              # 校验原子插座/插头与目录契约
bun run build:desktop            # 桌面包（webview-bun）
bun run package                  # Linux 打包
```

文档站预览：`cd apps/docs && bun run dev`（构建用 `bun run build`）。

## 架构

### elysiax 原子架构（核心）

`apps/dockyard/src/pages/` 下一个目录 = 一个自包含原子，按文件后缀划分职责：`*.di.ts`（模块身份证与 DI 装配）、`*.socket.ts`（唯一对外门）、`*.service.ts`、`*.repository.ts`、`schema.ts`、`*.actions.ts(x)`（端点）、`*.page.tsx` / `*.partials.tsx`（htmx 页面）、`client/`（整页 Solid 客户端）、`*.test.ts`（就近测试）、普通 `.ts`（原子内部模块，不参与路由）。

路由、页面表与 DI 容器由 codegen 生成到 `apps/dockyard/.elysiax/`（`routes.gen.ts`、`pages.gen.ts`、`services.gen.ts` 等），生成物不手改。`src/index.ts` 只负责 `start()`、本机认领/对账与后台轮询器启动。

硬契约：

- **跨原子 import 只能指向对方的 `<name>.socket.ts`**；socket 文件只 re-export，跨原子物理外键也经 socket 表引用。
- 每个原子在 `*.di.ts` 用 `provide()` 声明依赖（类引用 + 字符串值服务键），运行时 `di.get("xxxService")`。
- services 抛 `ServiceError`（`@elysiax/core`）；actions 不写 try/catch 回显，预期错误 `return status(code, { error })`。
- **渲染器单选**：htmx 原子的 actions 吐 HTML 片段（@kitajs/html JSX，路径用 `routes.*` 类型化 helper）；Solid 原子（目前是 canvas）的 actions 只吐 JSON，`client/` 依赖链禁止 Node-only 包（dotenv / bun:sqlite / fs 会导致浏览器打包失败）。
- 新建/改动原子的脚手架流程见 `.claude/skills/elysiax-atom/SKILL.md`；契约审查清单见 `.claude/agents/elysiax-reviewer.md`。

### 数据层

SQLite + drizzle。数据库文件与密钥在 `$XDG_DATA_HOME/dockyard/`，git 缓存与 docker 中继 socket 在 `$XDG_CACHE_HOME/dockyard/`（`src/shared/paths.ts`）。迁移以纯 TS 内嵌在每个原子的 `migrations.ts`，由 `src/shared/migrations-journal.ts` 显式聚合（顺序 = 外键依赖顺序），启动时同步迁移。`drizzle/` 下的 SQL 只用于与 `drizzle-kit generate` 做 diff，运行时以 TS 内嵌为准——改表结构要同时更新原子的迁移片段。

### 部署引擎与画布（领域核心）

- `deploy` 是无页面纯服务原子：六阶段 `Source → Build → Artifact → Ship → Run → Expose`。前半段形态组合在 `forms.ts` 的 `provision`，后半段对坐标无关、收敛在 `pipeline.ts` 的 `activate`/`captureArtifact`；回滚 = 激活旧产物。设计文档：`apps/docs/docs/部署抽象.md`。
- 本地与远程 docker 统一走 `servers/transport.ts` 的窄接口和 `docker-relay.ts`（本地 unix socket → 远端 docker.sock）；SSH 连接池是根 DI 容器里的单例。
- 后台轮询器在 `src/index.ts` 启动：容器状态 10s、GitHub 更新 60s。变更经 `deploy/events.ts` 事件总线以 SSE 推给画布，SSH 频率与前端在线数无关。
- `canvas` 是整页 Solid client：`client/` 内的 `board.tsx` 拉 `/api/canvas/board` 并接 SSE，结构操作走 canvas/deploy 的 JSON actions；htmx 页面与 Solid 页天然隔离，不得让两者操作同一 DOM。

### UI 与设计

共享控件样式唯一来源是 `apps/dockyard/panda.config.ts` + `panda/recipes.ts`，经 `styled-system/` 生成的框架无关 helper 供 htmx（`src/shared/ui/`）与 Solid 消费；不使用 Panda `styled` JSX，不引入跨渲染器组件运行时。`styled-system/` 和 `panda.gen.css` 都是生成物。Tailwind 布局类仍在 `src/global.css`，渐进迁移期间保留。

任何 UI 任务动手前先读视觉契约 `apps/dockyard/.interface-design/system.md` 与页面进度表 `apps/docs/docs/design/pages.md`（状态只认三态：未开始 / 待视觉验收 / 已验收）。UI 任务可直接用 `ui-craft` agent。

## 已知不一致

- `apps/dockyard/README.md` 指向 `../website/docs/`，实际文档站是 `apps/docs/`。
- `.claude/settings.json` 的 PostToolUse hook 调用 `scripts/atoms-mcp.ts`，仓库中不存在该脚本（hook 会静默失败）。



本仓库 TypeScript 规范（必须遵守）：

- 泛型函数体内禁止对泛型参数做成员访问并让结果进入返回值。
  需要精确类型时，把成员访问移到调用方，作为普通参数传入。
- 所有导出函数的返回类型必须显式标注，不依赖函数体推断。
- 禁止用 `as` 掩盖泛型退化；确需断言时在注释说明原因，且只允许在
  函数边界出现一处。

如果你认为需要违反以上任一条，先停下来解释原因，等我确认。