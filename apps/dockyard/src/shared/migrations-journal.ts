/**
 * 聚合迁移日志：各原子自带迁移片段——复制原子文件夹即带走建表 SQL。
 * 显式 import 聚合（原子就这几个，一行一个，比扫描透明）；
 * 顺序即同 timestamp 时的执行次序：被引用方（servers/projects）在前，引用方（canvas/deploy/edge）在后。
 *
 * 抽成独立模块的理由：shared/db.ts（生产路径）与 repository 单测（内存库跑真迁移）
 * 必须用同一份聚合——各自 import 会漂移，且跨原子 import 只能落在 shared（插座门禁）。
 */
import type { MigrationsJournal } from "drizzle-orm/migrator";
import { migrations as serversMigrations } from "../pages/servers/migrations";
import { migrations as projectsMigrations } from "../pages/projects/migrations";
import { migrations as canvasMigrations } from "../pages/canvas/migrations";
import { migrations as resourcesMigrations } from "../pages/resources/migrations";
import { migrations as deployMigrations } from "../pages/deploy/migrations";
import { migrations as edgeMigrations } from "../pages/edge/migrations";

// 迁移日志以纯 TS 内嵌（bun --compile 后没有文件系统里的 migrationsFolder）。
// 各片段的 timestamp 是全局历史序；聚合后重排为连续序号，保证同 timestamp 条目按上方 import 次序执行。
// 变更表结构后跑 `bunx drizzle-kit generate`（读 schema.all.ts），把 SQL 追加到对应原子的 migrations.ts。
export const migrationsJournal: MigrationsJournal = [
  ...serversMigrations,
  ...projectsMigrations,
  ...canvasMigrations,
  ...resourcesMigrations,
  ...deployMigrations,
  ...edgeMigrations,
]
  .sort((a, b) => a.timestamp - b.timestamp)
  .map((m, i) => ({ ...m, timestamp: i + 1 }));
