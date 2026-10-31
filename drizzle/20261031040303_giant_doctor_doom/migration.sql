CREATE TABLE "email_send_month" (
	"month" date,
	"priority" text,
	"sent" integer DEFAULT 0 NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "email_send_month_pkey" PRIMARY KEY("month","priority"),
	CONSTRAINT "email_send_month_priority_check" CHECK ("priority" in ('auth', 'transactional', 'digest')),
	CONSTRAINT "email_send_month_sent_check" CHECK ("sent" >= 0)
);
--> statement-breakpoint
CREATE TABLE "email_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"priority" text NOT NULL,
	"admitted" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"submitted" timestamp with time zone,
	"accepted" boolean,
	"provider_ref" text,
	"finished" timestamp with time zone,
	"account_id" uuid,
	"delivery_frequency" "notification_digest_frequency",
	"delivery_period" timestamp with time zone,
	"recipient_hash" text,
	CONSTRAINT "email_send_priority_check" CHECK ("priority" in ('auth', 'transactional', 'digest'))
);
--> statement-breakpoint
ALTER TABLE "notification_digest_delivery" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_digest_delivery" ADD COLUMN "available" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_digest_delivery" ADD COLUMN "attempt_token" uuid;--> statement-breakpoint
ALTER TABLE "notification_digest_delivery" ADD COLUMN "skipped" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_digest_delivery" ADD COLUMN "abandoned" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_digest_delivery" ADD COLUMN "skip_reason" text;--> statement-breakpoint
UPDATE "notification_digest_delivery"
SET "available" = COALESCE("failed", "created")
WHERE "sent" IS NULL AND "failed" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "email_send_admitted_idx" ON "email_send" ("admitted");--> statement-breakpoint
CREATE INDEX "email_send_priority_admitted_idx" ON "email_send" ("priority","admitted");--> statement-breakpoint
CREATE INDEX "email_send_unresolved_idx" ON "email_send" ("admitted") WHERE "submitted" is not null and "accepted" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "email_send_digest_recipient_idx" ON "email_send" ("account_id","delivery_frequency","delivery_period","recipient_hash") WHERE "priority" = 'digest' and "accepted" is not false;--> statement-breakpoint
CREATE INDEX "notification_digest_delivery_candidate_idx" ON "notification_digest_delivery" ("frequency","period_start","available","sent","skipped","abandoned");--> statement-breakpoint
ALTER TABLE "email_send" ADD CONSTRAINT "email_send_account_id_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE SET NULL;