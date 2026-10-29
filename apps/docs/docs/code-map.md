---
title: 代码地图（新人导览）
description: 第一次打开 dockyard 源码时的目录/文件说明书：每个原子做什么、deploy 深水区各文件分工、文件后缀怎么用、从哪读起。
---

# 代码地图（新人导览）

`src/` 下 100 来个文件看着吓人，但它们严格按 elysiax 的「一目录一原子」摆放：
**先认文件夹（原子），再认后缀（职责）**，就不会迷路。

> 框架级的后缀规则（codegen 扫什么、URL 怎么推导、`.elysiax/` 是什么）
> 见 elysiax 仓库的 [仓库导览与文件后缀](https://github.com/eastgold15/elysiax/blob/main/apps/docs/docs/repo-guide.md)。
> 本文只讲 **dockyard 自己**的文件。

## 1. 顶层目录

```
apps/dockyard/src/
├─ index.ts              # 入口：start()、启动本机认领与 docker 检测、后台轮询启动
├─ app.layout.tsx        # 全站壳（<html>、导航、toast 容器）
├─ global.css            # 全局样式/token
├─ infra.di.ts           # 基础设施 DI（db 最先装配）
├─ shared/               # 跨原子共享（浏览器安全、无业务逻辑）
└─ pages/                # ★ 全部业务，一个文件夹 = 一个原子
```

## 2. 原子一览

| 原子 | 形态 | 一句话职责 | 表 |
|---|---|---|---|
| `index` | htmx 页 | 根页面（重定向/项目列表） | — |
| `projects` | htmx 页 | 本地/远程项目登记、扫描目录、编辑器配置 | `projects` |
| `servers` | htmx 页 | 服务器 CRUD、SSH 通道、docker 检测与本机内置行 | `servers` |
| `canvas` | Solid client 页 | 世界地图画布：服务器卡/目标卡/依赖边/服务分组/透镜过滤 | `canvas_nodes`、`service_groups` |
| `ping` | htmx 页 | 最小示例页 | — |
| `deploy` | 纯服务 | 部署六阶段管线、日志、回滚、备份、自动更新、容器状态轮询 | `deploy_*` |
| `edge` | 纯服务 | Caddy 反代容器、域名与证书状态 | `domains` |
| `github` | 纯服务 | GitHub 仓库解析/拉取（无表） | — |
| `resources` | 纯服务 | 数据库模板与服务器资源（内存/CPU 限额） | `server_resources` |

纯服务模块 = 没有 `.page.tsx`，只提供 DI 与 `/api/<name>/*` JSON/片段端点，不占独立 URL。

## 3. 文件后缀在 dockyard 里的含义

| 后缀 | 在 dockyard 的例子 | 作用 |
|---|---|---|
| `*.di.ts` | `servers.di.ts` | 模块身份证；`provide(...)` 决定容器怎么装配 |
| `*.socket.ts` | `deploy.socket.ts` | 唯一对外门；别的原子只 import 这里 |
| `*.service.ts` | `deploy.service.ts` | 业务逻辑；抛 `ServiceError`，不碰 UI |
| `*.repository.ts` | `canvas.repository.ts` | 数据访问；依赖 `"db"` |
| `*.model.ts` | `canvas.model.ts` | 服务端与 client 同构的视图模型（纯类型/数据） |
| `*.actions.ts` | `deploy.actions.ts` | JSON 端点（Eden 类型来源） |
| `*.actions.tsx` | `servers.actions.tsx` | htmx 写端点，吐 HTML 片段 |
| `*.page.tsx` | `servers.page.tsx` | 整页（htmx） |
| `*.partials.tsx` | `servers.partials.tsx` | 展示组件 + GET 片段 |
| `schema.ts` / `migrations.ts` | `servers/schema.ts` | drizzle 表与迁移（迁移只追加，聚合到 `shared/migrations-journal.ts`） |
| `client/` | `canvas/client/` | 整页 Solid 客户端；`index.tsx` 标记 client 模式 |
| `*.test.ts(x)` | `servers.service.test.ts` | 就近测试；浏览器侧加 `--conditions=browser` |
| 普通 `.ts` | `deploy/forms.ts`、`canvas/zones.ts` | 本原子内部模块，不参与 codegen 路由 |

两条硬规则：

1. **跨原子只能 import 对方的 `*.socket.ts`**——直接摸别人的 service/schema 会被 doctor 与 review 打回。
2. **渲染器单选**：htmx 原子只吐 HTML，Solid 原子只吐 JSON（canvas 是后者）。

## 4. 深水区：deploy 文件分工

deploy 没有页面，是纯服务，文件按"阶段"拆：

| 文件 | 职责 |
|---|---|
| `deploy.di.ts` | 装配 repository/service/轮询器；parent/child 原子（runtime、backup）也走插座 |
| `deploy.service.ts` | 门面：目标 CRUD、部署/回滚/日志/域名等用例编排，SSE 事件在此发布 |
| `deploy.repository.ts` | `deploy_targets`、`deploy_runs`、`deploy_log_chunks`、产物表读写 |
| `deploy.actions.ts` | `/api/deploy/*` 端点（Eden 类型来源） |
| `events.ts` | 画布实时事件总线（`status` / `running` / `state` / `log` / `discovery`），SSE 上游 |
| `forms.ts` | 部署形态注册表：六阶段前半段（Source×Build×Ship）各形态实现 |
| `pipeline.ts` | 六阶段流水线：统一承接 Activate（Run/Expose）与 captureArtifact |
| `detect.ts` | compose 自动识别（services/domains/env），检测先行、声明覆盖 |
| `container-poller.ts` | 每 10s 轮询容器状态 + 发现层指纹，diff 后推 SSE |
| `update-poller.ts` | 每 60s 取目标最新源码版本（本地来源看本地 git HEAD，其余看 GitHub 分支 sha），按 `deployPolicy`（manual/notify/auto）行事 |
| `runtime/` | 子原子：容器运行时操作（compose up/logs/exec 等） |
| `backup/` | 子原子：数据库实例备份列出/下载/恢复（本地落盘 `backups/target-<id>/`；恢复先自动安全备份，postgres/mongo 可自动恢复，mysql/redis 只下载） |

父子原子（`deploy.runtime`、`deploy.backup`）也各有自己的 `*.di.ts` / `*.socket.ts`，嵌套规则一致。

## 5. canvas（画布）文件分工

| 文件 | 职责 |
|---|---|
| `canvas.di.ts` / `canvas.socket.ts` | 装配与唯一对外门（表锚点 + 服务类） |
| `canvas.model.ts` | `/board` 的视图模型（`BoardModel`/`CardModel`/`DiscoveredContainer`） |
| `canvas.repository.ts` | 服务器卡、服务分组的位置/尺寸持久化 |
| `canvas.service.ts` | 画布内的结构操作（建卡/分组/移动） |
| `canvas.actions.ts` | `/api/canvas/*`：board、SSE、CRUD、分辨率解析 |
| `zones.ts` | 本机/远程车道规则（单一事实源，服务端裁决与 client 钳制共用） |
| `discovery.ts` | 发现层纯函数：未纳管容器过滤、项目归属反查、变更指纹 |
| `client/index.tsx` | Solid 入口（HTMLBundle 壳挂载点） |
| `client/app.tsx` | 页头透镜选择器 + UiBus 模态层 |
| `client/board.tsx` | 世界地图主组件：结构拉取、SSE、拖拽/连线、透镜过滤、布局派生 |
| `client/nodes.tsx` | 各类型卡片视图（服务器/app/服务/db/分组/发现容器） |
| `client/drawers.tsx` | 抽屉与弹窗（向导、服务详情、日志、域名、变量、发现详情） |
| `client/live.ts` | SSE → Solid store（部署状态、容器状态、日志增量） |
| `client/ui.ts` | UiBus（视图判别联合 + refresh 事件） |
| `client/lens.ts` | 项目透镜的模块级信号 |
| `client/api.ts` | Eden Treaty 客户端 + 类型化路径助手 |
| `client/console.tsx` | xterm ↔ WebSocket 终端 |

## 6. servers 文件分工

| 文件 | 职责 |
|---|---|
| `servers.actions.tsx` / `servers.page.tsx` / `servers.partials.tsx` | 服务器页三件套（CRUD、共享资源弹窗、TOFU 信任确认） |
| `servers.service.ts` / `servers.repository.ts` | 业务与数据层；`ensureLocal()` 本机认领、`transport(id)` 通道选择 |
| `host.ts` | `isLocalHost`（回环判定，socket 转出口） |
| `transport.ts` | `ServerTransport` 窄接口：本地进程直连 / 远程 SSH；`openServerSftp` 统一文件通道 |
| `ssh-pool.ts` | SSH 连接池、主机指纹 TOFU、密钥/代理凭据 |
| `docker-relay.ts` | dockerode 走 SSH 中继：本地 unix socket → 远端 docker.sock |

## 7. shared 里有什么

| 文件 | 职责 |
|---|---|
| `db.ts` | drizzle 实例（bun:sqlite） |
| `schema.all.ts` | **仅构建期**给 drizzle-kit 看全量 schema；运行时禁止 import |
| `migrations-journal.ts` | 聚合各原子迁移片段（显式 import，一行一个） |
| `paths.ts` | XDG 数据目录/备份目录等路径 |
| `crypto.ts` | `enc1:` AES-256-GCM 加解密（密钥 0600） |
| `env-text.ts` | .env 文本 ↔ map（零依赖，client 也用） |
| `ui/` | L4 共享渲染件：`cn()`、`PageHeader`、`Empty`、`Modal` |

## 8. 新人阅读路线（约 15 分钟）

1. elysiax 的 [仓库导览与文件后缀](https://github.com/eastgold15/elysiax/blob/main/apps/docs/docs/repo-guide.md)（先懂规则）
2. `src/index.ts` → `app.layout.tsx`（应用怎么起）
3. `pages/servers/`：最标准的 htmx 三件套（`di → socket → service → repository → page/partials/actions`）
4. `pages/deploy/forms.ts` → `pipeline.ts`（部署六阶段，配合 [部署抽象](./部署抽象.md)）
5. `pages/canvas/client/board.tsx`（Solid 世界地图，配合 [画布 client 模式](./canvas-client.mdx)）
6. 想核对 URL/DI 装配：看 `.elysiax/pages.gen.ts`、`.elysiax/container.gen.ts`

## 9. 常用命令

```bash
bun run dev                 # 开发（codegen + bun --hot，client 源变化自动重启）
bunx elysiax gen            # 重新生成 .elysiax/
bunx elysiax doctor         # 契约体检（DI/路由/插座/迁移/错误/端点 schema）
bun run typecheck           # gen + tsc --noEmit
bun test --conditions=browser  # 全量测试
```

> 启动 dev server 或跑真实部署属于运行时冒烟——先询问用户，不要自作主张。
