import type { MigrationsJournal } from "drizzle-orm/migrator";

/** resources 原子的迁移片段 */
export const migrations: MigrationsJournal = [
  {
    name: "0010_openship_shared",
    timestamp: 11,
    sql: "CREATE TABLE `resources` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`serverId` integer NOT NULL,\n\t`name` text NOT NULL,\n\t`dbType` text NOT NULL,\n\t`containerName` text,\n\t`envKey` text NOT NULL,\n\t`credsJson` text,\n\t`createdAt` integer NOT NULL,\n\tCONSTRAINT `fk_server_resources_serverId_servers_id_fk` FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `server_resources_serverId_name_unique` UNIQUE(`serverId`,`name`)\n);",
  },
];
