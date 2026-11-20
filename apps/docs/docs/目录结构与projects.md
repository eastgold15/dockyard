---
title: 目录结构与 projects 原子
description: dockyard 仓库目录怎么分层、.actions 后缀文件是干什么的、apps/dockyard/src/pages/projects 里每个文件负责什么。
---

# 目录结构与 projects 原子

本文回答三个问题：

1. 仓库目录按什么规则分层
2. `*.actions.ts` 这类后缀文件是什么意思
3. `apps/dockyard/src/pages/projects/` 一个文件夹里都有哪些文件、各管什么

---

## 1. 仓库顶层

Bun workspace + Turborepo 的 monorepo：

```
dockyard/
├─ apps/
│  ├─ dockyard/          # 主应用（Bun + Elysia + elysiax 原子架构）
│  └─ docs/              # Blume 文档站（本文所在仓库）
├─ package.json          # workspace 根，命令经 turbo 转发
├─ turbo.json
└─ ...
```

框架 **elysiax** 不在 npm 上，而是通过 `link:../../../elysiax/packages/*` 指到同级仓库
`~/Documents/GitHub/elysiax`。所以改框架行为要两个仓库一起改。

`apps/dockyard` 内部再分三层：

```
apps/dockyard/
├─ src/                  # 全部运行时代码（见下一节）
├─ panda.config.ts       # 设计 token 与 recipe 源头
├─ panda/recipes.ts      # 控件 recipe
├─ styled-system/        # Panda 生成物，勿手改
├─ .elysiax/             # elysiax codegen 生成物，勿手改
└─ drizzle/              # 只用于与 drizzle-kit 做 diff，运行时以原子内迁移为准
```

---

## 2. `apps/dockyard/src/`：先认文件夹，再认后缀

```
src/
├─ index.ts              # 入口：start()、本机认领/对账、启动后台轮询器
├─ infra.di.ts           # 根 DI：db 等基础设施最先装配
├─ shared/               # 跨原子共享，无业务逻辑
│  ├─ db.ts              # drizzle 实例（bun:sqlite）
│  ├─ migrations-journal.ts  # 各原子迁移片段的显式聚合（顺序 = 外键依赖）
│  ├─ paths.ts           # XDG 数据/缓存目录
│  ├─ solid-ui/          # 共享控件与反馈件（toast/确认框/输入框/AppShell）
│  └─ ...
└─ pages/                # ★ 全部业务：一个文件夹 = 一个原子
   ├─ index.page.tsx     # 根路由（它没有文件夹，因为只有一个文件）
   ├─ projects/          # 项目列表页（本文第 5 节拆解）
   ├─ servers/           # 服务器页
   ├─ canvas/            # 画布页
   ├─ ping/              # 最小示例页
   └─ deploy/ edge/ github/ resources/   # 纯服务原子（无页面，只提供 /api/* 端点）
```

原子（atom）= 一个自包含目录，前端、后端、表结构、迁移、测试都放在同一个文件夹里。
页面 URL 与原子目录一一对应，这样改一个页面不会跨目录散开。

### 2.1 文件后缀就是职责标签

codegen 靠文件名后缀判断每个文件在系统里的角色：

| 后缀 | 例子 | 职责 |
| --- | --- | --- |
| `*.di.ts` | `projects.di.ts` | 模块身份证。声明 `route` 和 `provide(...)` 依赖，决定容器怎么装配 |
| `*.socket.ts` | `projects.socket.ts` | 唯一对外门。其他原子只能 import 这个文件，不许直接摸别人的 service/schema |
| `*.service.ts` | `projects.service.ts` | 业务规则（校验、默认值、幂等、编排）。抛 `ServiceError`，不碰 HTTP |
| `*.repository.ts` | `projects.repository.ts` | 持久化读写。只依赖 `"db"`，不做业务校验 |
| `schema.ts` | `projects/schema.ts` | drizzle 表定义（表锚点） |
| `migrations.ts` | `projects/migrations.ts` | 本原子的迁移片段，聚合进 `shared/migrations-journal.ts` |
| `*.actions.ts` | `projects.actions.ts` | HTTP 端点（JSON API），codegen 自动挂到 `/api/<原子名>` |
| `*.types.ts` | `projects.types.ts` | 跨端共享的纯类型契约（client 与 actions 共用，无值导入） |
| `*.page.tsx` | `index.page.tsx` | 服务端整页（旧 htmx 形态；当前仅根路由还在用） |
| `client/` | `projects/client/` | 整页 Solid 客户端；`index.tsx` 是挂载入口 |
| `*.test.ts(x)` | `projects.service.test.ts` | 就近测试 |
| 普通 `.ts` | `projects/config.ts` | 原子内部模块，不参与 codegen 路由 |

两条硬规则：

1. **跨原子只能 import 对方的 `*.socket.ts`**。
2. **渲染器单选**：一个原子的 actions 要么只吐 JSON（Solid 页），要么只吐 HTML 片段（htmx 页），不能混。当前除根路由外，所有页面都是 Solid client，所以 `.actions.ts` 只吐 JSON。

---

## 3. `*.actions.ts` 到底是什么

一句话：**actions 文件就是这个原子的 HTTP 路由表**。

```ts
// projects.actions.ts（节选）
export default defineRoutes<ProjectsServices>()
  .get("/", async ({ di }) => model(di))
  .post("/", { body: t.Object({ name: ... }) }, async ({ di, body }) => ...)
  .delete("/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => ...);
```

### 3.1 codegen 怎么处理它

- `elysiax gen` / `elysiax dev` 扫描 `src/pages/*/*.actions.ts`，读出你声明的路由。
- 生成到 `.elysiax/routes.gen.ts`、`.elysiax/pages.gen.ts`，例如：
  - `projects` 页 URL：`/projects`（来自 `projects.di.ts` 的 `route`）
  - 它的 API 前缀：`/api/projects`，子路径由 `.get("/")`、`.post("/config")` 等决定
- 生成物不要手改；文件名和后缀就是 codegen 的输入契约。

### 3.2 actions 里只做三件事

1. **声明入参 schema**（`t.Object(...)`），运行时校验由 Elysia 完成
2. **调用 service**（通过 `di.get("xxxService")`）
3. **返回结果**（JSON；预期错误用 `status(code)`，业务错误由 service 抛 `ServiceError` 后框架统一回显）

不写业务校验、不直接调 repository、不拼持久化参数。

### 3.3 它还是 Eden 的类型来源

`socket.ts` 里有一行：

```ts
import type projectActions from "./projects.actions";
export type ProjectApi = typeof projectActions;
```

client 的 `api.ts` 用 `treaty<ProjectApi>(...)`，于是**端点路径、params、body、返回类型全部端到端类型安全**——后端改接口，前端立刻编译报错。

### 3.4 和 `.page.tsx` / `client/` 的分工

| 文件 | 形态 | URL | 输出 |
| --- | --- | --- | --- |
| `*.page.tsx` | 服务端渲染整页 | 原子的 `route` | HTML |
| `client/index.tsx` | 整页 Solid client，codegen 生成壳 HTML | 原子的 `route` | 浏览器里渲染 |
| `*.actions.ts` | API 路由表 | `/api/<原子名>/*` | JSON |

同一个原子可以同时有「页面 + actions」：`di.ts` 的 `route` 管页面地址，actions 管数据接口。

---

## 4. `apps/dockyard/src/pages/projects/`

这个原子负责**项目列表页**：扫描本地目录、列出未检出的 GitHub 项目空间、新建/删除项目、
用编辑器或 lazygit 打开本地目录。页面是整页 Solid client。

### 4.1 目录一览

```
projects/
├─ projects.di.ts          # 模块身份证 + DI 装配
├─ projects.socket.ts      # 对外唯一门
├─ projects.actions.ts     # /api/projects/* JSON 端点
├─ projects.service.ts     # 业务规则：新建校验、本地项目落库幂等
├─ projects.repository.ts  # projects 表读写
├─ projects.types.ts       # client 与 actions 共用的 DTO / 视图模型
├─ schema.ts               # drizzle `projects` 表
├─ migrations.ts           # projects 表的迁移片段
├─ config.ts               # 用户级配置读写（~/.config/dockyard/config.json）
├─ local.service.ts        # 磁盘扫描、编辑器/lazygit 启动
└─ client/
   ├─ index.tsx            # Solid 挂载入口
   ├─ app.tsx              # 整页 UI：列表、编辑器 split-button、行点击
   ├─ modals.tsx           # 扫描目录配置弹窗、新建项目弹窗
   └─ api.ts               # Eden Treaty 客户端
```

### 4.2 逐文件职责

| 文件 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `projects.di.ts` | `route: "/projects"`；`provide()` 装配 repository / service / localService；声明跨原子依赖 `GithubService` | 业务逻辑 |
| `projects.socket.ts` | 只 re-export：`projects` 表、`Project` 类型、`ProjectService`、`ProjectApi` 类型 | 任何实现 |
| `projects.actions.ts` | `/api/projects` 端点：列表、取/存扫描目录、新建弹窗数据、打开编辑器、建项目、删项目；入参 schema 都在这里 | 业务校验、直接碰 DB |
| `projects.service.ts` | 项目用例：`list`/`byId`、`create`（校验 repoUrl）、`ensureLocal`（扫描进画布时按 localPath 幂等落库）、`remove`、`newProjectData`（GitHub 仓库列表，失败降级为空） | HTTP 概念 |
| `projects.repository.ts` | `projects` 表的 select/insert/delete；`create` 里生成唯一 slug（重名自动加 `-2`、`-3`） | 业务规则、抛 HTTP 错误 |
| `projects.types.ts` | `ProjectListModel`（列表页视图模型）、`ScanConfig`、`NewProjectData`，并 re-export `LocalProject`/`Project`/`RepoBrief` | 运行时值 |
| `schema.ts` | `projects` 表：`name`/`slug`/`repoUrl`/`localPath`/`sourceType`/`branch`/`rootDir`/`createdAt`；`Project` 从表行派生 | 迁移 |
| `migrations.ts` | `projects` 表的建表与后续加列（只追加），由 `shared/migrations-journal.ts` 聚合 | 运行时逻辑 |
| `config.ts` | 读写 `~/.config/dockyard/config.json`：`scanDirs`（默认 `~/Documents/GitHub`）、`defaultEditor`；支持 `~/` 展开 | 数据库 |
| `local.service.ts` | 浅扫一级子目录（含 `.git` 或 `package.json` 即算项目）、解析 git origin、探测本机编辑器/终端/懒 git、detached 启动编辑器 | 落库（落库交给 `ProjectService.ensureLocal`） |
| `client/index.tsx` | `render(<App />, #root)`，Solid 页入口 | 业务 |
| `client/app.tsx` | 整页 UI：`AppShell` + `PageHeader`；本地/远端两组列表；行点击进画布；编辑器 split-button；删除确认 | 数据获取之外的业务规则 |
| `client/modals.tsx` | 两个弹窗：扫描目录配置（一行一个目录）、新建项目（选 GitHub 仓库或跳过）；弹层行为走 Kobalte `Modal` | 端点调用（由 `app.tsx` 负责） |
| `client/api.ts` | `treaty<ProjectApi>(origin + "/api/projects")`，路径/入参/返回值全类型安全 | 业务 |

### 4.3 一次请求怎么走

```
client/app.tsx
  └─ client/api.ts (Eden Treaty，类型来自 projects.socket.ts)
       └─ GET /api/projects
            └─ projects.actions.ts: model(di)
                 ├─ di.get("projectService").list()      → repository → db
                 ├─ di.get("localService").toolchain()   → 探测本机工具链
                 └─ di.get("localService").scan(projects) → 扫 scanDirs 下的目录
```

点「新建项目」：

```
POST /api/projects
  → projects.actions.ts（body schema 校验）
    → projects.service.create()（repoUrl 格式校验）
      → projects.repository.create()（生成唯一 slug、写 projects 表）
```

### 4.4 端点清单

| 方法 + 路径 | 作用 |
| --- | --- |
| `GET /api/projects` | 列表页全量数据：本地扫描结果 + 未检出项目空间 + 工具链 |
| `GET /api/projects/config` | 读取扫描目录配置 |
| `POST /api/projects/config` | 保存扫描目录（按行拆、trim、去空）并返回刷新后的列表 |
| `GET /api/projects/new` | 新建项目弹窗的初始数据（GitHub 仓库列表，失败降级） |
| `POST /api/projects/open` | 用编辑器或 lazygit 打开本地目录；成功 204，失败由 `ServiceError` 回显 |
| `POST /api/projects` | 新建项目空间 |
| `DELETE /api/projects/:id` | 删除项目空间 |

---

## 5. 顺便：读一个原子的顺序

拿 `projects` 练手，推荐顺序：

1. `projects.di.ts` —— 有哪些服务、依赖谁
2. `projects.actions.ts` —— 对外暴露了哪些接口
3. `projects.service.ts` —— 每个接口的业务规则
4. `projects.repository.ts` + `schema.ts` —— 落到哪张表
5. `projects.socket.ts` —— 别的原子能看到什么
6. `client/app.tsx` —— UI 怎么消费这些接口

更完整的全仓库导览见 [代码地图（新人导览）](./code-map.md)。
