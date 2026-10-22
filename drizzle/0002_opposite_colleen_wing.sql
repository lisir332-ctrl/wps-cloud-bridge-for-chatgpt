CREATE TABLE `wps_acceptance_runs` (
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`suite` text NOT NULL,
	`connection_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`checks_json` text NOT NULL,
	`artifacts_json` text NOT NULL,
	`error_json` text,
	PRIMARY KEY(`user_id`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `wps_acceptance_latest` ON `wps_acceptance_runs` (`user_id`,`suite`,`started_at`);