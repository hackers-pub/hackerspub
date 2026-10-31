CREATE TABLE "auth_throttle" (
	"key" text PRIMARY KEY,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "auth_throttle_count_check" CHECK ("count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "auth_throttle_window_start_idx" ON "auth_throttle" ("window_start");