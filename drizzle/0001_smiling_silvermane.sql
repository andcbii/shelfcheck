CREATE TABLE `shelfcheck_state_chunks` (
	`user_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `chunk_index`)
);
