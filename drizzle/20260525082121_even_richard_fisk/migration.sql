CREATE TYPE "push_notification_preview_policy" AS ENUM('public_only', 'all', 'none');--> statement-breakpoint
CREATE TYPE "push_notification_service" AS ENUM('apns', 'fcm', 'web_push');--> statement-breakpoint
CREATE TABLE "push_notification_target" (
	"id" uuid PRIMARY KEY,
	"service" "push_notification_service" NOT NULL,
	"account_id" uuid NOT NULL,
	"token" text,
	"endpoint" text,
	"p256dh" text,
	"auth" text,
	"expiration_time" timestamp with time zone,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "push_notification_target_shape_check" CHECK (
        CASE "service"
          WHEN 'apns' THEN
            "token" ~ '^[0-9a-f]{64}$' AND
            "endpoint" IS NULL AND
            "p256dh" IS NULL AND
            "auth" IS NULL AND
            "expiration_time" IS NULL
          WHEN 'fcm' THEN
            "token" IS NOT NULL AND
            length("token") > 0 AND
            "endpoint" IS NULL AND
            "p256dh" IS NULL AND
            "auth" IS NULL AND
            "expiration_time" IS NULL
          WHEN 'web_push' THEN
            "token" IS NULL AND
            "endpoint" IS NOT NULL AND
            length("endpoint") > 0 AND
            "p256dh" IS NOT NULL AND
            length("p256dh") > 0 AND
            "auth" IS NOT NULL AND
            length("auth") > 0
        END
      )
);
--> statement-breakpoint
INSERT INTO "push_notification_target" (
  "id",
  "service",
  "account_id",
  "token",
  "created",
  "updated"
)
SELECT
  gen_random_uuid(),
  'apns'::"push_notification_service",
  "account_id",
  "device_token",
  "created",
  "updated"
FROM "apns_device_token";
--> statement-breakpoint
INSERT INTO "push_notification_target" (
  "id",
  "service",
  "account_id",
  "token",
  "created",
  "updated"
)
SELECT
  gen_random_uuid(),
  'fcm'::"push_notification_service",
  "account_id",
  "device_token",
  "created",
  "updated"
FROM "fcm_device_token";
--> statement-breakpoint
DROP TABLE "apns_device_token";--> statement-breakpoint
DROP TABLE "fcm_device_token";--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "push_notification_preview_policy" "push_notification_preview_policy" DEFAULT 'public_only'::"push_notification_preview_policy" NOT NULL;--> statement-breakpoint
CREATE INDEX "push_notification_target_account_id_index" ON "push_notification_target" ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_notification_target_service_token_unique" ON "push_notification_target" ("service","token") WHERE ("token" is not null);--> statement-breakpoint
CREATE UNIQUE INDEX "push_notification_target_endpoint_unique" ON "push_notification_target" ("endpoint") WHERE ("endpoint" is not null);--> statement-breakpoint
ALTER TABLE "push_notification_target" ADD CONSTRAINT "push_notification_target_account_id_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE;
