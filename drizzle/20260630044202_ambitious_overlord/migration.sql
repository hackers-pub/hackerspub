CREATE TYPE "notification_digest_frequency" AS ENUM('daily', 'weekly');--> statement-breakpoint
CREATE TABLE "notification_digest_delivery" (
	"account_id" uuid,
	"frequency" "notification_digest_frequency",
	"period_start" timestamp with time zone,
	"notifications_count" integer NOT NULL,
	"sent" timestamp with time zone,
	"failed" timestamp with time zone,
	"error" text,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "notification_digest_delivery_pkey" PRIMARY KEY("account_id","frequency","period_start")
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "notification_email_digest_daily" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "notification_email_digest_weekly" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_digest_delivery_created_idx" ON "notification_digest_delivery" ("created");--> statement-breakpoint
ALTER TABLE "notification_digest_delivery" ADD CONSTRAINT "notification_digest_delivery_account_id_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_emoji_check", ADD CONSTRAINT "notification_emoji_check" CHECK (
        CASE "type"::text
          WHEN 'react'
          THEN "emoji" IS NOT NULL AND "custom_emoji_id" IS NULL
            OR "emoji" IS NULL AND "custom_emoji_id" IS NOT NULL
          ELSE "emoji" IS NULL AND "custom_emoji_id" IS NULL
        END
      );--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_organization_conversion_request_id_check", ADD CONSTRAINT "notification_organization_conversion_request_id_check" CHECK (
        CASE "type"::text
          WHEN 'organization_conversion_request'
          THEN "organization_conversion_request_id" IS NOT NULL
          ELSE "organization_conversion_request_id" IS NULL
        END
      );
