ALTER TYPE "public"."account_link_icon" ADD VALUE 'akkoma' BEFORE 'bluesky';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "allowed_email" (
	"email" text PRIMARY KEY NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
