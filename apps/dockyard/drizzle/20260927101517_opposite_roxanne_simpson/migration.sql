CREATE TABLE `domains` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`targetId` integer NOT NULL,
	`hostname` text NOT NULL,
	`serviceName` text,
	`targetPort` integer NOT NULL,
	`dnsStatus` text DEFAULT 'unknown' NOT NULL,
	`sslStatus` text DEFAULT 'none' NOT NULL,
	`sslError` text,
	`createdAt` integer NOT NULL,
	CONSTRAINT `fk_domains_targetId_deploy_targets_id_fk` FOREIGN KEY (`targetId`) REFERENCES `deploy_targets`(`id`) ON DELETE CASCADE,
	CONSTRAINT `domains_targetId_hostname_unique` UNIQUE(`targetId`,`hostname`)
);
