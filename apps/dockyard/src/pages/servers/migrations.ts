import type { MigrationsJournal } from "drizzle-orm/migrator";

/** servers 原子的迁移片段——复制本文件夹即带走建表 SQL。聚合排序见 shared/db.ts */
export const migrations: MigrationsJournal = [
  {
    name: "0000_init",
    timestamp: 1,
    sql: "CREATE TABLE `servers` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`name` text NOT NULL,\n\t`host` text NOT NULL,\n\t`port` integer DEFAULT 22 NOT NULL,\n\t`user` text NOT NULL,\n\t`authType` text DEFAULT 'key' NOT NULL,\n\t`keyPath` text,\n\t`password` text,\n\t`dockerStatus` text DEFAULT 'unknown' NOT NULL,\n\t`dockerVersion` text,\n\t`hostKeyFingerprint` text,\n\t`lastCheckedAt` integer,\n\t`createdAt` integer NOT NULL\n);",
  },
  {
    name: "0002_instance_logical_db",
    timestamp: 3,
    sql: "ALTER TABLE `servers` ADD `machineId` text;--> statement-breakpoint\nALTER TABLE `servers` ADD `dockerId` text;",
  },
];
