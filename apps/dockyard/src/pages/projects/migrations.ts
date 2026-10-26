import type { MigrationsJournal } from "drizzle-orm/migrator";

/** projects 原子的迁移片段 */
export const migrations: MigrationsJournal = [
  {
    name: "0000_init",
    timestamp: 1,
    sql: "CREATE TABLE `projects` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`name` text NOT NULL,\n\t`slug` text NOT NULL UNIQUE,\n\t`createdAt` integer NOT NULL\n);",
  },
  {
    name: "0007_nested_canvas",
    timestamp: 8,
    sql: "ALTER TABLE `projects` ADD `repoUrl` text;",
  },
  {
    name: "0009_local_path",
    timestamp: 10,
    sql: "ALTER TABLE `projects` ADD `localPath` text;",
  },
  {
    name: "0010_openship_shared",
    timestamp: 11,
    sql: "ALTER TABLE `projects` ADD `sourceType` text;--> statement-breakpoint\nALTER TABLE `projects` ADD `branch` text;--> statement-breakpoint\nALTER TABLE `projects` ADD `rootDir` text;",
  },
];
