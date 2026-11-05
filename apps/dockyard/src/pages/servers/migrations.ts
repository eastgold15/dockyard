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
  {
    // 内置本机：程序自动认领的行（固定 127.0.0.1 + 当前用户），存量回环行启动时升级
    name: "0021_server_builtin",
    timestamp: 21,
    sql: "ALTER TABLE `servers` ADD `builtin` integer DEFAULT 0 NOT NULL;",
  },
  {
    // Docker 镜像源（JSON 数组字符串）；applyRegistryMirrors 写进远端 daemon.json
    name: "0022_server_registry_mirrors",
    timestamp: 22,
    sql: "ALTER TABLE `servers` ADD `registryMirrors` text;",
  },
];
