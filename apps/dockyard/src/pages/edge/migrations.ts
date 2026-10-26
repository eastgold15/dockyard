import type { MigrationsJournal } from "drizzle-orm/migrator";

/** edge 原子的迁移片段 */
export const migrations: MigrationsJournal = [
  {
    name: "0003_domains",
    timestamp: 4,
    sql: "CREATE TABLE `edge_domains` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`targetId` integer NOT NULL,\n\t`hostname` text NOT NULL,\n\t`serviceName` text,\n\t`targetPort` integer NOT NULL,\n\t`dnsStatus` text DEFAULT 'unknown' NOT NULL,\n\t`sslStatus` text DEFAULT 'none' NOT NULL,\n\t`sslError` text,\n\t`createdAt` integer NOT NULL,\n\tCONSTRAINT `fk_domains_targetId_deploy_targets_id_fk` FOREIGN KEY (`targetId`) REFERENCES `deploy_targets`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `domains_targetId_hostname_unique` UNIQUE(`targetId`,`hostname`)\n);",
  },
];
