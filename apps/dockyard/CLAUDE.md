## Dockyard

## 文档约束

文档统一放本仓库 `apps/docs/docs/`（blume 文档站），AI 读写文档都去这里，不散落在别处。
框架（elysiax）的文档在 elysiax 仓库的 `apps/docs/docs/`，各放各的。

## UI - 设计规范（先读）

任何 UI 任务（新页面、改样式、加组件、视觉审查）开始前，先读：

1. `.interface-design/system.md` — 视觉契约：颜色/排版/间距/组件规格/例外边界
2. `../docs/docs/design/pages.md` — 页面进度表：现状差异、实施状态、验收记录

规范没有覆盖到的新模式：先与用户确认，确认后同步更新 system.md 与 pages.md。不得仅凭本轮对话记忆另起风格。状态纪律：文档已写 ≠ 源码已改 ≠ 浏览器验收通过；进度表只认三态（未开始 / 待视觉验收 / 已验收）。

## 目录归属（垂直切片）

页面 = 一个 URL = 一个文件夹，前端（`client/`）与后端（`*.di.ts` / `*.socket.ts` / `*.service.ts` / `*.repository.ts` / `schema.ts` / `migrations.ts` / `*.actions.ts`）同目录。归属按顺序判断：

1. **有独立 URL**（能刷新、能外链）→ 新建页面文件夹（原子），不塞进别的页面。
2. **没有 URL 且被 ≥2 个页面使用** → `src/shared/`（壳 `AppShell`、`Nav`、控件、`feedback`）。
3. **否则** → 留在所属页面文件夹内。

页面内子目录只按“视图区域”拆，深度最多两层：

- `client/<region>/`，区域名用业务面（`board` / `nodes` / `panes` / `infra`），**禁止** `components` / `hooks` / `utils` 这类技术名词。
- 服务端逻辑留在原子根层，不因 UI 差异搬家；跨页逻辑复用走 DI service，跨页 UI 复用走 `shared/solid-ui`，两条通道不混用。
- 量化触发条件：单文件 >400 行，或一个文件里装了 3 个以上独立弹窗/视图 → 拆区域；只是“组件有点多” → 不拆。

## UI - Panda CSS

共享控件样式统一使用 `panda.config.ts` / `panda/recipes.ts` 中的 token 与 recipe。htmx 与 Solid 只消费 `styled-system/` 生成的框架无关 helper，不使用 Panda `styled` JSX，不引入跨渲染器组件运行时，也不再使用 shadcn-htmx registry/snippets。

修改 Panda 配置后运行 `bun run css:panda`；开发时可另开 `bun run panda:watch`。`styled-system/` 与 `panda.gen.css` 都是生成物，不手改。现有 Tailwind 布局类在渐进迁移期间保留。

## 依赖优先原则

实现任何通用功能前，必须先检查是否有现成的成熟库可用：

1. 先查 package.json 已有依赖能否满足
2. 再评估 npm 上的主流包（周下载量、维护状态），优先用 Context7 查其文档；UI/组件类需求优先选所用框架官方生态的库（Solid → Kobalte，对标 React 的 Radix），禁止手写弹层、焦点管理、可访问性原语
3. 只有确认现成方案不满足需求时才手写实现，并在回复中说明为什么不用现成库
   通用功能包括但不限于：日期处理、校验、ID 生成、重试/限流、文件监听、CLI 解析、日志等。

canvas、servers、projects、ping 均为整页 Solid client（各自 `client/`），路由由壳 HTMLBundle 服务。应用不使用 htmx：`app.layout.tsx` / `shared/ui` 与 `@elysiax/htmx` 依赖均已移除，页面外框是客户端组件 `AppShell`（`src/shared/solid-ui/`，侧边栏 + 移动导航 + 主区）。所有控件与反馈件（toast/确认框/输入框）都在 `src/shared/solid-ui/`：Panda recipe 出样式、Kobalte 出行为，四个页面共用。client 代码依赖链禁 Node-only 包（dotenv/bun:sqlite → 浏览器打包 500），跨端类型放 `<name>.types.ts` 纯类型文件。

错误处理约定：services 抛 ServiceError（@elysiax/core），actions 不写 try/catch 回显；预期错误 return status(code, { error })。

## 类型纪律

类型只从单一来源派生，禁止重抄已有形状：

- `di.get()` 的类型由 codegen 的 `ServiceMap` 自动推导。禁止手写 `get(k: "xxx"): Xxx` 重载，禁止 `di: { get(name: string): any }` 这类把类型擦成 `any`。跨文件统一用 `type Di = { get<K extends keyof ServiceMap>(k: K): ServiceMap[K] }`。
- 表行/插入类型从 drizzle 派生：`typeof t.$inferSelect`、`Pick<typeof t.$inferInsert, ...>`。禁止手抄表字段。
- repository 的查询/写入方法不写返回类型标注，交给 drizzle 推断。方法一律写成 `async`（签名因此是真正的 `Promise<行类型>`，而不是暴露 drizzle builder），行类型由 `db.select().from(...)` / `.returning()` 链式调用推断。需要更紧的返回契约时在调用方标注，不在 repository 里重复。
- 引用别的原子的 service 类型时用 `ServiceMap["xxxService"]` / `Pick<ServiceMap, ...>` 索引，不重复声明类名。
- 只有三类类型允许手写：`t.Object` 校验 schema、`ServiceError` 判别、形状确实变了的跨原子 DTO / 视图模型。
- HTTP 入参的 schema 常量放 `<atom>.schema.ts`（与同目录的 `schema.ts` 是两回事：后者是 drizzle 表锚点）。Route 与 Service import 同一个常量，Service 侧只 `import type`（类型被擦除，不把 Elysia 拖进服务层）。
- 从 schema 派生类型用 elysia 的 `UnwrapSchema`（`import { t, type UnwrapSchema } from "elysia"`）：elysia 2 不导出 `Static`，typebox 的 `Static` 不认 `t.Numeric` 的字符串强转（端口/数字字段会推成 `string | number`）。
- 跨原子共用 schema 常量（Route 在 A 原子、Service 在 B 原子）时，常量由 B 原子的 `<name>.socket.ts` 导出，插座门禁只认这条路。
- 纯转发的 Service 方法用 `Parameters<Repo["method"]>` 派生签名，不重抄参数类型；有业务逻辑的方法入参从 schema 派生。

新增冗余类型视为缺陷；`as` / `as unknown as` 只在第三方类型缺口处使用，并在注释里写明缺口来源。

进行测试，需要询问我

- 熟悉的框架和现有代码模式直接修改；
- 只读实际要改的文件及其直接依赖；
- 遇到真实报错或版本 API 不确定时才查文档；
- 完成后审查实际 diff，不在修改前反复论证；
- 不再为了“绝对稳妥”扩大检查范围。


纯转发用 Parameters<Repo["method"]> 消除重复；有业务逻辑的方法保留显式参数，因为它本来就是不同的契约。


### 本仓库的两处例外（已知取舍）

- **读模型拼装留在 Route**：`/canvas/board` 的卡片拼装、`/deploy/new-app` 的向导数据要同时用 project/server/deploy/edge 四个 service。下沉进任一 service 都会形成 canvas↔deploy 的 DI 环，只能留在 Route（它是视图组装，不是业务校验）。
- **资源不存在 = ServiceError(404)**：Service 用 `mustGet` / `mustTarget` / `mustGetDomain` 抛 404，Route 不再自己判空 `return status(404, ...)`。


---

# 分层规范（Route / Service / Repository）

## 1. 三层职责（唯一真理）

| 层 | 只负责 | 禁止 |
|---|---|---|
| Route（Elysia） | HTTP 入参 schema、运行时校验、调用 Service | 业务校验、拼持久化参数、直接调 Repository |
| Service | 业务规则（幂等 / 默认值 / trim / 事务 / 事件 / 权限） | 重复声明入参类型、直接碰 DB |
| Repository | 持久化读写 | 业务校验、抛 HTTP 语义错误 |

> 以下 `Xxx` 泛指任意业务模块（如 `User`、`Order`、`Canvas`……），规则对所有模块一致。

## 2. 类型源只允许两个

1. **Elysia schema 常量** —— 管所有 HTTP 入参类型
2. **Repository 方法签名** —— 管所有持久化入参类型

其余任何位置的类型**必须派生**，不得重复声明。

## 3. 派生规则（强制）

- Service 中有业务逻辑的方法 → 入参类型从 schema 派生：
  ```ts
  import type { Static } from "elysia";
  export type CreateXxxInput = Static<typeof createXxxSchema>;
  ```
- Service 中纯转发方法 → 用 `Parameters` 派生，不手写：
  ```ts
  updateXxx(...args: Parameters<XxxRepository["update"]>) {
    return this.repo.update(...args);
  }
  ```
- Route handler 入参类型 → 由 Elysia 根据 `body/params/query` schema **自动推导**，禁止手写 `as` 或重复 interface。

## 4. Schema 放置

- 每个模块一个 `xxx.schema.ts`，导出 schema 常量 + 对应 `Static` 类型。
- Route 与 Service **import 同一个常量**，禁止各自定义结构相同的 schema/type。
- 命名：schema 常量 `<action>Schema`；派生类型 `<Action>Input` / `<Action>Patch`。

## 5. Service 写法约束

- 纯转发方法：一行 `return this.repo.x(...args)`，不加校验、不加默认值。
- 有业务逻辑方法：显式参数 + 显式校验，参数类型来自 schema 派生。
- Service **不得**引入 Elysia 的 `t`、`Context`、`Elysia` 等 HTTP 概念；仅可 import `Static` 类型。
- Service 抛错统一用 `ServiceError`，不得抛 Elysia 的 `status()`。

## 6. Repository 写法约束（不许为上层妥协）

- 保持独立、可单独测试，签名即契约。
- **禁止**为配合 Service 转发而改动 Repository（不继承、不暴露原型、不内置转发钩子）。
- Repository 不感知 HTTP、不感知 Elysia。

## 7. 禁止事项（反模式）

- ❌ 在 Service 手写与 schema 重复的内联对象类型
- ❌ 在 Route handler 写业务 `if` 校验
- ❌ 用 Proxy / 原型遍历做"自动转发"（破坏可读性与可调试性）
- ❌ 为消灭几行透传而反向改造 Repository
- ❌ Service 直接返回 Elysia 的 `status`/`error` 对象

## 8. 新增一个接口的检查清单

1. 在 `xxx.schema.ts` 定义 schema + `Static` 类型（入参非空时）
2. Route 挂 schema，handler 只做 `service.xxx(...)` 调用
3. Service：有逻辑则写校验并用派生类型；纯转发则用 `Parameters<Repo["m"]>`
4. Repository：需要新持久化操作才加方法，签名即类型源
5. 确认**没有任何一处**重复声明了入参结构

## 9. 判定"该不该有 Service 方法"

- 有校验 / 默认值 / 幂等 / 事务 / 事件 / 权限 → **必须有**，写在 Service
- 纯 CRUD 透传且无任何附加语义 → 可保留一行透传，或由调用方直接用 `repo`；**不得**为此改造 Repository

---

改动要点：全文用 `Xxx` 泛指模块，规则与示例均不绑定具体业务；`Canvas` 仅作为"任意模块之一"被提及，模型读后会把规范应用到所有模块而非某个特定模块。