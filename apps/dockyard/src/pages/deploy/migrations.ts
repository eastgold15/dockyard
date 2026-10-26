import type { MigrationsJournal } from "drizzle-orm/migrator";

/** deploy 原子的迁移片段 */
export const migrations: MigrationsJournal = [
  {
    name: "0000_init",
    timestamp: 1,
    sql: "CREATE TABLE `deploy_targets` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`nodeId` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`name` text NOT NULL,\n\t`repoUrl` text,\n\t`branch` text DEFAULT 'main',\n\t`composePath` text DEFAULT 'docker-compose.yml',\n\t`serviceName` text,\n\t`dbType` text,\n\t`remoteDir` text,\n\t`envJson` text,\n\t`lastKnownSha` text,\n\t`updateAvailable` integer DEFAULT false NOT NULL,\n\t`createdAt` integer NOT NULL,\n\tCONSTRAINT `fk_deploy_targets_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE\n);\n--> statement-breakpoint\nCREATE TABLE `deploy_runs` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`targetId` integer NOT NULL,\n\t`status` text DEFAULT 'queued' NOT NULL,\n\t`commitSha` text,\n\t`logText` text DEFAULT '' NOT NULL,\n\t`startedAt` integer NOT NULL,\n\t`finishedAt` integer,\n\tCONSTRAINT `fk_deployments_targetId_deploy_targets_id_fk` FOREIGN KEY (`targetId`) REFERENCES `deploy_targets`(`id`) ON DELETE CASCADE\n);",
  },
  {
    name: "0001_target_etag",
    timestamp: 2,
    sql: "ALTER TABLE `deploy_targets` ADD `etag` text;",
  },
  {
    name: "0002_instance_logical_db",
    timestamp: 3,
    sql: "ALTER TABLE `deploy_targets` ADD `instanceOf` integer REFERENCES deploy_targets(id);--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `containerName` text;--> statement-breakpoint\nPRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `__new_deploy_targets` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`nodeId` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`name` text NOT NULL,\n\t`instanceOf` integer,\n\t`containerName` text,\n\t`repoUrl` text,\n\t`branch` text DEFAULT 'main',\n\t`composePath` text DEFAULT 'docker-compose.yml',\n\t`serviceName` text,\n\t`dbType` text,\n\t`remoteDir` text,\n\t`envJson` text,\n\t`lastKnownSha` text,\n\t`etag` text,\n\t`updateAvailable` integer DEFAULT false NOT NULL,\n\t`createdAt` integer NOT NULL,\n\tCONSTRAINT `fk_deploy_targets_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_deploy_targets_instanceOf_deploy_targets_id_fk` FOREIGN KEY (`instanceOf`) REFERENCES `deploy_targets`(`id`),\n\tCONSTRAINT `deploy_targets_nodeId_kind_name_unique` UNIQUE(`nodeId`,`kind`,`name`)\n);\n--> statement-breakpoint\nINSERT INTO `__new_deploy_targets`(`id`, `nodeId`, `kind`, `name`, `repoUrl`, `branch`, `composePath`, `serviceName`, `dbType`, `remoteDir`, `envJson`, `lastKnownSha`, `etag`, `updateAvailable`, `createdAt`) SELECT `id`, `nodeId`, `kind`, `name`, `repoUrl`, `branch`, `composePath`, `serviceName`, `dbType`, `remoteDir`, `envJson`, `lastKnownSha`, `etag`, `updateAvailable`, `createdAt` FROM `deploy_targets`;--> statement-breakpoint\nDROP TABLE `deploy_targets`;--> statement-breakpoint\nALTER TABLE `__new_deploy_targets` RENAME TO `deploy_targets`;--> statement-breakpoint\nPRAGMA foreign_keys=ON;",
  },
  {
    name: "0004_override_compose",
    timestamp: 5,
    sql: "ALTER TABLE `deploy_targets` ADD `overrideCompose` text;",
  },
  {
    name: "0005_depends_on",
    timestamp: 6,
    sql: "ALTER TABLE `deploy_targets` ADD `dependsOn` text;",
  },
  {
    name: "0006_target_services",
    timestamp: 7,
    sql: "ALTER TABLE `deploy_targets` ADD `servicesJson` text;",
  },
  {
    name: "0007_nested_canvas",
    timestamp: 8,
    sql: "ALTER TABLE `deploy_targets` ADD `x` integer;--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `y` integer;--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `serviceLayout` text;--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `depEdges` text;",
  },
  {
    name: "0008_card_size",
    timestamp: 9,
    sql: "ALTER TABLE `deploy_targets` ADD `w` integer;--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `h` integer;",
  },
  {
    name: "0010_openship_shared",
    timestamp: 11,
    sql: "ALTER TABLE `deploy_targets` ADD `groupId` integer REFERENCES service_groups(id);",
  },
  {
    name: "0011_up_services",
    timestamp: 12,
    sql: "ALTER TABLE `deploy_targets` ADD `upServices` text;",
  },
  // 世界地图前置：deploy_targets 增加 projectId（项目归属从 canvas_nodes 下沉到 target），
  // 并从旧 canvas_nodes 回填——必须先于 canvas 的 0020 重建跑（timestamp 13 < 14），回填后旧表才被 DROP。
  {
    name: "0013_target_project",
    timestamp: 13,
    sql: "ALTER TABLE `deploy_targets` ADD `projectId` integer REFERENCES projects(id);\n--> statement-breakpoint\nUPDATE `deploy_targets` SET `projectId` = (SELECT `projectId` FROM `canvas_nodes` WHERE `canvas_nodes`.`id` = `deploy_targets`.`nodeId`);",
  },
  // 部署硬化批：策略/通道三列 + 回滚快照五列 + 日志分块表（logText 存量整体转一条 seq=0 chunk，
  // startedAt 是 drizzle timestamp 模式存的毫秒，直接作 ts）。
  {
    name: "0015_deploy_hardening",
    timestamp: 15,
    sql: "ALTER TABLE `deploy_targets` ADD `deployPolicy` text DEFAULT 'notify' NOT NULL;--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `buildPlatform` text;--> statement-breakpoint\nALTER TABLE `deploy_targets` ADD `artifactShipped` integer DEFAULT false NOT NULL;--> statement-breakpoint\nALTER TABLE `deploy_runs` ADD `trigger` text DEFAULT 'ui' NOT NULL;--> statement-breakpoint\nALTER TABLE `deploy_runs` ADD `rollbackOf` integer;--> statement-breakpoint\nALTER TABLE `deploy_runs` ADD `imageSnapshot` text;--> statement-breakpoint\nALTER TABLE `deploy_runs` ADD `snapshotJson` text;--> statement-breakpoint\nALTER TABLE `deploy_runs` ADD `project` text;--> statement-breakpoint\nCREATE TABLE `deploy_log_chunks` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`runId` integer NOT NULL,\n\t`seq` integer NOT NULL,\n\t`text` text NOT NULL,\n\t`ts` integer NOT NULL,\n\tCONSTRAINT `fk_deploy_log_chunks_runId_deploy_runs_id_fk` FOREIGN KEY (`runId`) REFERENCES `deploy_runs`(`id`) ON DELETE CASCADE\n);--> statement-breakpoint\nCREATE INDEX `idx_deploy_log_chunks_run` ON `deploy_log_chunks` (`runId`,`seq`);--> statement-breakpoint\nINSERT INTO `deploy_log_chunks` (`runId`, `seq`, `text`, `ts`) SELECT `id`, 0, `logText`, `startedAt` FROM `deploy_runs` WHERE `logText` != '';",
  },
  // 悬空外键修复：0011 的 `ADD groupId REFERENCES service_groups(id)` 指向一个从未以该名
  // 存在过的表（真名 canvas_groups）。走过改名历史的老库被 SQLite 自动改写为 canvas_groups，
  // 全新装库则留着悬空引用——FK ON 下任何 deploy_targets 插入都会炸。重建表归一两种历史。
  {
    name: "0016_fix_group_fk",
    timestamp: 16,
    sql: "PRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `__new_deploy_targets` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`nodeId` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`name` text NOT NULL,\n\t`instanceOf` integer,\n\t`containerName` text,\n\t`repoUrl` text,\n\t`branch` text DEFAULT 'main',\n\t`composePath` text DEFAULT 'docker-compose.yml',\n\t`serviceName` text,\n\t`dbType` text,\n\t`remoteDir` text,\n\t`envJson` text,\n\t`lastKnownSha` text,\n\t`etag` text,\n\t`updateAvailable` integer DEFAULT false NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`overrideCompose` text,\n\t`dependsOn` text,\n\t`servicesJson` text,\n\t`x` integer,\n\t`y` integer,\n\t`serviceLayout` text,\n\t`depEdges` text,\n\t`w` integer,\n\t`h` integer,\n\t`groupId` integer REFERENCES `canvas_groups`(`id`),\n\t`upServices` text,\n\t`projectId` integer REFERENCES projects(id),\n\t`deployPolicy` text DEFAULT 'notify' NOT NULL,\n\t`buildPlatform` text,\n\t`artifactShipped` integer DEFAULT false NOT NULL,\n\tCONSTRAINT `fk_deploy_targets_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_deploy_targets_instanceOf_deploy_targets_id_fk` FOREIGN KEY (`instanceOf`) REFERENCES `deploy_targets`(`id`),\n\tCONSTRAINT `deploy_targets_nodeId_kind_name_unique` UNIQUE(`nodeId`,`kind`,`name`)\n);--> statement-breakpoint\nINSERT INTO `__new_deploy_targets`(`id`, `nodeId`, `kind`, `name`, `instanceOf`, `containerName`, `repoUrl`, `branch`, `composePath`, `serviceName`, `dbType`, `remoteDir`, `envJson`, `lastKnownSha`, `etag`, `updateAvailable`, `createdAt`, `overrideCompose`, `dependsOn`, `servicesJson`, `x`, `y`, `serviceLayout`, `depEdges`, `w`, `h`, `groupId`, `upServices`, `projectId`, `deployPolicy`, `buildPlatform`, `artifactShipped`) SELECT `id`, `nodeId`, `kind`, `name`, `instanceOf`, `containerName`, `repoUrl`, `branch`, `composePath`, `serviceName`, `dbType`, `remoteDir`, `envJson`, `lastKnownSha`, `etag`, `updateAvailable`, `createdAt`, `overrideCompose`, `dependsOn`, `servicesJson`, `x`, `y`, `serviceLayout`, `depEdges`, `w`, `h`, `groupId`, `upServices`, `projectId`, `deployPolicy`, `buildPlatform`, `artifactShipped` FROM `deploy_targets`;--> statement-breakpoint\nDROP TABLE `deploy_targets`;--> statement-breakpoint\nALTER TABLE `__new_deploy_targets` RENAME TO `deploy_targets`;--> statement-breakpoint\nPRAGMA foreign_keys=ON;",
  },
];
