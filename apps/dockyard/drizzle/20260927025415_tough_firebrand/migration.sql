CREATE TABLE `canvas_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`projectId` integer NOT NULL,
	`serverId` integer NOT NULL,
	`x` integer DEFAULT 40 NOT NULL,
	`y` integer DEFAULT 40 NOT NULL,
	`w` integer DEFAULT 320 NOT NULL,
	`h` integer DEFAULT 240 NOT NULL,
	CONSTRAINT `fk_canvas_nodes_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_canvas_nodes_serverId_servers_id_fk` FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `deploy_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`nodeId` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`repoUrl` text,
	`branch` text DEFAULT 'main',
	`composePath` text DEFAULT 'docker-compose.yml',
	`serviceName` text,
	`dbType` text,
	`remoteDir` text,
	`envJson` text,
	`lastKnownSha` text,
	`updateAvailable` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	CONSTRAINT `fk_deploy_targets_nodeId_canvas_nodes_id_fk` FOREIGN KEY (`nodeId`) REFERENCES `canvas_nodes`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`targetId` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`commitSha` text,
	`logText` text DEFAULT '' NOT NULL,
	`startedAt` integer NOT NULL,
	`finishedAt` integer,
	CONSTRAINT `fk_deployments_targetId_deploy_targets_id_fk` FOREIGN KEY (`targetId`) REFERENCES `deploy_targets`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`slug` text NOT NULL UNIQUE,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`user` text NOT NULL,
	`authType` text DEFAULT 'key' NOT NULL,
	`keyPath` text,
	`password` text,
	`dockerStatus` text DEFAULT 'unknown' NOT NULL,
	`dockerVersion` text,
	`hostKeyFingerprint` text,
	`lastCheckedAt` integer,
	`createdAt` integer NOT NULL
);
