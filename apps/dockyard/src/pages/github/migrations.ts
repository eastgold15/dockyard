import type { MigrationsJournal } from "drizzle-orm/migrator";

/** github 原子的迁移片段 */
export const migrations: MigrationsJournal = [
  {
    name: "0030_github_app",
    timestamp: 30,
    sql: "CREATE TABLE `github_apps` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`appId` text NOT NULL,\n\t`installationId` text NOT NULL,\n\t`privateKeyEnc` text NOT NULL,\n\t`webhookSecretEnc` text,\n\t`accountLogin` text,\n\t`createdAt` integer NOT NULL,\n\t`updatedAt` integer NOT NULL\n);",
  },
];
