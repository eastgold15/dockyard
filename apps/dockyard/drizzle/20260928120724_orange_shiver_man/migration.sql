CREATE TABLE `server_resources` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`serverId` integer NOT NULL,
	`name` text NOT NULL,
	`dbType` text NOT NULL,
	`containerName` text,
	`envKey` text NOT NULL,
	`credsJson` text,
	`createdAt` integer NOT NULL,
	CONSTRAINT `fk_server_resources_serverId_servers_id_fk` FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `server_resources_serverId_name_unique` UNIQUE(`serverId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `service_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`nodeId` integer NOT NULL,
	`name` text NOT NULL,
	`x` integer DEFAULT 24 NOT NULL,
	`y` integer DEFAULT 24 NOT NULL,
	`w` integer DEFAULT 360 NOT NULL,
	`h` integer DEFAULT 280 NOT NULL,
	CONSTRAINT `fk_service_groups_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `service_groups_nodeId_name_unique` UNIQUE(`nodeId`,`name`)
);
--> statement-breakpoint
ALTER TABLE `deploy_targets` ADD `groupId` integer REFERENCES service_groups(id);--> statement-breakpoint
ALTER TABLE `projects` ADD `sourceType` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `rootDir` text;