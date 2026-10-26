import type { MigrationsJournal } from "drizzle-orm/migrator";

/** canvas 原子的迁移片段 */
export const migrations: MigrationsJournal = [
  {
    name: "0000_init",
    timestamp: 1,
    sql: "CREATE TABLE `canvas_nodes` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`projectId` integer NOT NULL,\n\t`serverId` integer NOT NULL,\n\t`x` integer DEFAULT 40 NOT NULL,\n\t`y` integer DEFAULT 40 NOT NULL,\n\t`w` integer DEFAULT 320 NOT NULL,\n\t`h` integer DEFAULT 240 NOT NULL,\n\tCONSTRAINT `fk_canvas_nodes_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_canvas_nodes_serverId_servers_id_fk` FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON DELETE CASCADE\n);",
  },
  {
    name: "0010_openship_shared",
    timestamp: 11,
    sql: "CREATE TABLE `canvas_groups` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`nodeId` integer NOT NULL,\n\t`name` text NOT NULL,\n\t`x` integer DEFAULT 24 NOT NULL,\n\t`y` integer DEFAULT 24 NOT NULL,\n\t`w` integer DEFAULT 360 NOT NULL,\n\t`h` integer DEFAULT 280 NOT NULL,\n\tCONSTRAINT `fk_service_groups_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `service_groups_nodeId_name_unique` UNIQUE(`nodeId`,`name`)\n);",
  },
  // 世界地图化：canvas_nodes 去 projectId、serverId 全局唯一。
  // 幂等策略：journal（__drizzle_migrations）保证整条只跑一次；新装库先由 0000 建旧表再经此重建，路径一致。
  // 多语句用 `--> statement-breakpoint` 分隔（drizzle 内嵌迁移的分隔符，不是分号）。
  // FK 处理（已在 bun:sqlite 上彩排验证）：
  //  - drizzle 把全部迁移包在一个事务里，而 PRAGMA foreign_keys 在事务内是 no-op → 首句 COMMIT 跳出；
  //  - 不能给旧表改名暂存：RENAME 会改写子表 FK 文本（legacy_alter_table 在 foreign_keys=ON 时拦不住，实测），
  //    且 FK ON 时 DROP 父表的隐式 DELETE 会级联清空子表（defer_foreign_keys 不推迟级联，实测）。
  //    所以保持旧表原名 → 建 canvas_nodes_new → 拷贝去重 → 子表重指 → FK OFF 下 DROP → 新表改名接手；
  //  - 结尾重新 BEGIN 把事务交还给 drizzle（它还要插 journal 行并 COMMIT）。
  //  - 失败恢复：重建在自己的事务里，任何一步失败 drizzle 的 ROLLBACK 只回滚本迁移，重跑从旧表原样开始。
  // 去重：同一 serverId 的多张项目卡保留 MIN(id)（坐标/尺寸随该行），其余行的 deploy_targets/canvas_groups 重指到幸存节点。
  // 依赖次序：deploy 原子的 0013（deploy_targets 回填 projectId）必须先跑（timestamp 13 < 14），它还要读旧表的 projectId。
  {
    name: "0020_world_map",
    timestamp: 14,
    sql: [
      "COMMIT;", // 跳出 drizzle 的迁移事务（否则 foreign_keys pragma 无效）
      "PRAGMA foreign_keys = OFF;",
      "BEGIN;", // 自己的事务保护重建
      "CREATE TABLE `canvas_nodes_new` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`serverId` integer NOT NULL,\n\t`x` integer DEFAULT 40 NOT NULL,\n\t`y` integer DEFAULT 40 NOT NULL,\n\t`w` integer DEFAULT 320 NOT NULL,\n\t`h` integer DEFAULT 240 NOT NULL,\n\tCONSTRAINT `canvas_nodes_serverId_unique` UNIQUE(`serverId`),\n\tCONSTRAINT `fk_canvas_nodes_serverId_servers_id_fk` FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON DELETE CASCADE\n);",
      "INSERT INTO `canvas_nodes_new` (`id`, `serverId`, `x`, `y`, `w`, `h`)\n\tSELECT `id`, `serverId`, `x`, `y`, `w`, `h` FROM `canvas_nodes`\n\tWHERE `id` IN (SELECT MIN(`id`) FROM `canvas_nodes` GROUP BY `serverId`);",
      // 被去重删掉的节点：子行重指到同 serverId 的幸存节点（旧表还在，可回查 serverId）
      "UPDATE `deploy_targets` SET `nodeId` = (\n\tSELECT n.`id` FROM `canvas_nodes_new` n\n\tWHERE n.`serverId` = (SELECT o.`serverId` FROM `canvas_nodes` o WHERE o.`id` = `deploy_targets`.`nodeId`)\n) WHERE `nodeId` NOT IN (SELECT `id` FROM `canvas_nodes_new`);",
      "UPDATE `canvas_groups` SET `nodeId` = (\n\tSELECT n.`id` FROM `canvas_nodes_new` n\n\tWHERE n.`serverId` = (SELECT o.`serverId` FROM `canvas_nodes` o WHERE o.`id` = `canvas_groups`.`nodeId`)\n) WHERE `nodeId` NOT IN (SELECT `id` FROM `canvas_nodes_new`);",
      "DROP TABLE `canvas_nodes`;", // FK OFF：不级联；子表 FK 文本仍指向 canvas_nodes（没改过名）
      "ALTER TABLE `canvas_nodes_new` RENAME TO `canvas_nodes`;", // 只改写指向 canvas_nodes_new 的引用（不存在）
      "COMMIT;",
      "PRAGMA foreign_keys = ON;",
      "BEGIN;", // 交还给 drizzle 收尾（插 journal + COMMIT）
    ].join("\n--> statement-breakpoint\n"),
  },
];
