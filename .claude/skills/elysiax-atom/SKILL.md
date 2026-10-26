---
name: elysiax-atom
description: 脚手架新的 elysiax 原子模块（页面/子域/弹窗），按凹凸插座契约生成 di/schema/repository/service/socket/actions/page/partials 骨架。当用户说"新建原子/新页面/新模块/加个弹窗原子"时使用。
---

# elysiax-atom：原子脚手架

按凹凸插座契约创建新原子。**先问用户三个问题**（可合并成一条问）：

1. **名字**（kebab-case，如 `backups`）和**位置**（默认 `apps/dockyard/src/pages/<name>/`；嵌套子原子则是 `pages/<父>/<name>/`）
2. **形态**：页面原子（全层）/ 子域原子（无 URL，纯服务）/ 弹窗原子（partials + actions + di + socket，无 schema 无 repo）
3. **渲染器单选**：htmx（actions 吐 HTML 片段）还是 Solid client（actions 吐 JSON + `client/` 目录）

## 通用规则（所有形态）

- 身份证两件套：`<name>.di.ts` + `<name>.socket.ts`（无对外承诺则只写 di，不写 socket）。
- 插座纯度：socket.ts 只 re-export，注释标明"对外承诺"。
- 跨原子依赖：import 对方 `<x>.socket.ts`，且 di provide 里声明类引用依赖（`provide(XService, [DepService, "db"])`，类引用 + 字符串值服务键）。
- services 抛 `ServiceError`（`@elysiax/core`）；actions 零 try/catch，预期错误 `return status(code, { error })`（status 从 "elysia" 导入）。
- 所有文件注释用中文。

## 模板

### `<name>.di.ts`（所有形态必写）

```ts
import { defineModule, provide } from "@elysiax/core";
import { <Name>Service } from "./<name>.service";

export default defineModule({
  route: "/<name>", // 子域原子无 URL 则省略 route
  provides: {
    <name>Service: provide(<Name>Service, ["db"]), // 依赖写类引用；值服务用字符串键
  },
});
```

### `schema.ts`（页面原子；弹窗原子跳过）

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ── <中文说明> ──
export const <name>s = sqliteTable("<name>s", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type <Name> = typeof <name>s.$inferSelect;
```

表名全局唯一；跨表外键经对方 socket 引用：`otherId: integer().references(() => otherSocketTable.id)`。迁移片段随原子走（参照 `pages/servers/migrations.ts`）。

### `<name>.repository.ts`（有 schema 才写）

```ts
import { <name>s, type <Name> } from "./schema";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export class <Name>Repository {
  constructor(private readonly db: BunSQLiteDatabase) {}

  list(): Promise<<Name>[]> {
    return this.db.select().from(<name>s);
  }
}
```

### `<name>.service.ts`

```ts
import { ServiceError } from "@elysiax/core";
import type { <Name>Repository } from "./<name>.repository";
import type { <Name> } from "./schema";

export class <Name>Service {
  constructor(private readonly repo: <Name>Repository) {}

  list() {
    return this.repo.list();
  }

  async mustGet(id: number): Promise<<Name>> {
    const row = await this.repo.byId(id);
    if (!row) throw new ServiceError("<中文错误消息>", 404);
    return row;
  }
}
```

### `<name>.socket.ts`（有对外承诺才写）

```ts
// <name> 原子的插座：对外承诺的全部契约。原子内部随便重构，本文件导出保持稳定。
// 规则：跨原子 import 只允许指向本文件；client（浏览器包）只允许 import type。
export { <name>s } from "./schema";
export type { <Name> } from "./schema";
export { <Name>Service } from "./<name>.service";
```

只增不减：删导出 = 拔插头，需确认没有引用方。

### `<name>.actions.tsx`（htmx 形态）

参照 `pages/servers/servers.actions.tsx`：

```tsx
import { defineRoutes } from "../../../.elysiax";
import { t } from "elysia";
import { <Name>List } from "./<name>.partials";

const form = t.Object({ name: t.String({ minLength: 1 }) });

export default defineRoutes().post("/", { body: form }, async ({ di, body, toast }) => {
  await di.get("<name>Service").create(body);
  toast(`「${body.name}」已添加`);
  return <<Name>List items={await di.get("<name>Service").list()} />;
});
```

要点：校验写 `t.Object` schema；返回的是 partials 组件（HTML 片段），**不是** JSON；预期错误 `return status(422, { error: "..." })`。

### `<name>.page.tsx` + `<name>.partials.tsx`（htmx 形态）

- page = 整页壳（hx 目标容器），partials = 可替换片段组件。
- UI 组件先用 `bunx shadcn-htmx list` 查现成组件，样式遵守 `apps/dockyard/.interface-design/system.md`。
- hx 路径用 `routes.pages.<name>.*` 类型化 helper，不写裸路径。
- `hx-on::` 属性用 spread：`{...{ "hx-on::after-request": "..." }}`。

### Solid client 形态（渲染器选了 Solid 时）

- 目录多一个 `client/`（身份证判定的"普通抽屉"）：`client/index.tsx` 入口 + `client/app.tsx`。
- actions 只吐 JSON（参照 `pages/canvas/canvas.actions.ts` 挂在 `/api/<name>`），返回类型不要被 HTML 联合污染。
- `client/` 依赖链禁 Node-only 包（dotenv/bun:sqlite → 打包 500）；import 服务端只允许 `import type`。

## 完成后

1. 跑 `elysiax doctor`（若有）验证插座/插头对应。
2. 提醒用户：路由/UI 验收按 `docs/design/pages.md` 三态纪律走（文档已写 ≠ 源码已改 ≠ 浏览器验收通过）。
