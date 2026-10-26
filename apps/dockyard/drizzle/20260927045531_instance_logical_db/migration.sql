ALTER TABLE `deploy_targets` ADD `instanceOf` integer REFERENCES deploy_targets(id);--> statement-breakpoint
ALTER TABLE `deploy_targets` ADD `containerName` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `machineId` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `dockerId` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_deploy_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`nodeId` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`instanceOf` integer,
	`containerName` text,
	`repoUrl` text,
	`branch` text DEFAULT 'main',
	`composePath` text DEFAULT 'docker-compose.yml',
	`serviceName` text,
	`dbType` text,
	`remoteDir` text,
	`envJson` text,
	`lastKnownSha` text,
	`etag` text,
	`updateAvailable` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	CONSTRAINT `fk_deploy_targets_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_deploy_targets_instanceOf_deploy_targets_id_fk` FOREIGN KEY (`instanceOf`) REFERENCES `deploy_targets`(`id`),
	CONSTRAINT `deploy_targets_nodeId_kind_name_unique` UNIQUE(`nodeId`,`kind`,`name`)
);
--> statement-breakpoint
INSERT INTO `__new_deploy_targets`(`id`, `nodeId`, `kind`, `name`, `repoUrl`, `branch`, `composePath`, `serviceName`, `dbType`, `remoteDir`, `envJson`, `lastKnownSha`, `etag`, `updateAvailable`, `createdAt`) SELECT `id`, `nodeId`, `kind`, `name`, `repoUrl`, `branch`, `composePath`, `serviceName`, `dbType`, `remoteDir`, `envJson`, `lastKnownSha`, `etag`, `updateAvailable`, `createdAt` FROM `deploy_targets`;--> statement-breakpoint
DROP TABLE `deploy_targets`;--> statement-breakpoint
ALTER TABLE `__new_deploy_targets` RENAME TO `deploy_targets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;