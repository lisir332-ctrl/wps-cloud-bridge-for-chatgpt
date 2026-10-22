CREATE TABLE `wps_auth_attempts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`code_cipher` text NOT NULL,
	`code_iv` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_poll_at` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wps_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`token_cipher` text NOT NULL,
	`token_iv` text NOT NULL,
	`connected_at` integer NOT NULL,
	`expires_at` integer,
	`expired` integer DEFAULT 0 NOT NULL,
	`verified_at` integer
);
