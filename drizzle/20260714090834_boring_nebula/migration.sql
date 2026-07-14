CREATE TYPE "outbox_event_status" AS ENUM('pending', 'processing', 'completed', 'dead');--> statement-breakpoint
CREATE SEQUENCE "public"."outbox_event_sequence" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY,
	"event_type" text NOT NULL,
	"payload_version" smallint NOT NULL,
	"message_id" text NOT NULL,
	"group_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"position" integer NOT NULL,
	"ordering_key" text,
	"status" "outbox_event_status" DEFAULT 'pending'::"outbox_event_status" NOT NULL,
	"payload" jsonb,
	"activity_id" text,
	"activity_type" text,
	"inbox" text,
	"available" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"processing_attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"leased" timestamp with time zone,
	"last_error" jsonb,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"completed" timestamp with time zone,
	"failed" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_event_message_idx" ON "outbox_event" ("event_type","message_id");--> statement-breakpoint
CREATE INDEX "outbox_event_ready_idx" ON "outbox_event" ("event_type","status","available","sequence","position");--> statement-breakpoint
CREATE INDEX "outbox_event_ordering_idx" ON "outbox_event" ("ordering_key","status","sequence","position");--> statement-breakpoint
CREATE INDEX "outbox_event_lease_idx" ON "outbox_event" ("status","leased");