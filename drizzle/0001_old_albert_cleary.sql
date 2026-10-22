CREATE TABLE `wps_executions` (
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`plan_hash` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	PRIMARY KEY(`user_id`, `request_id`)
);
