ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'invitation_granted';
COMMIT;
BEGIN;
CREATE TYPE "invitation_distribution_kind" AS ENUM('scheduled', 'manual', 'grant');--> statement-breakpoint
CREATE TABLE "invitation_distribution" (
	"id" uuid PRIMARY KEY,
	"kind" "invitation_distribution_kind" NOT NULL,
	"actor_id" uuid,
	"actor_username" varchar(50),
	"target_id" uuid,
	"target_username" varchar(50),
	"amount" integer NOT NULL,
	"accounts_affected" integer NOT NULL,
	"eligible_accounts_count" integer,
	"top_third_count" integer,
	"cutoff_date" timestamp with time zone,
	"period_end" timestamp with time zone,
	"run_key" text UNIQUE,
	"note" text,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "invitation_distribution_amount_check" CHECK ("amount" >= 0),
	CONSTRAINT "invitation_distribution_accounts_affected_check" CHECK ("accounts_affected" >= 0),
	CONSTRAINT "invitation_distribution_grant_check" CHECK (
        "kind" <> 'grant' OR
        ("amount" > 0 AND "accounts_affected" = 1)
      ),
	CONSTRAINT "invitation_distribution_bulk_check" CHECK (
        "kind" = 'grant' OR
        ("period_end" IS NOT NULL AND "amount" = "accounts_affected")
      ),
	CONSTRAINT "invitation_distribution_target_check" CHECK ("kind" = 'grant' OR "target_id" IS NULL),
	CONSTRAINT "invitation_distribution_target_username_check" CHECK ("kind" <> 'grant' OR "target_username" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "invitation_distribution_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "invitation_amount" integer;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "left_invitations" SET DATA TYPE integer USING "left_invitations"::integer;--> statement-breakpoint
ALTER TABLE "invitation_link" ALTER COLUMN "invitations_left" SET DATA TYPE integer USING "invitations_left"::integer;--> statement-breakpoint
CREATE INDEX "invitation_distribution_created_idx" ON "invitation_distribution" ("created","id");--> statement-breakpoint
CREATE INDEX "invitation_distribution_target_idx" ON "invitation_distribution" ("target_id","created");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_invitation_distribution_idx" ON "notification" ("account_id","type","invitation_distribution_id") WHERE "type" = 'invitation_granted';--> statement-breakpoint
ALTER TABLE "invitation_distribution" ADD CONSTRAINT "invitation_distribution_actor_id_account_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "invitation_distribution" ADD CONSTRAINT "invitation_distribution_target_id_account_id_fkey" FOREIGN KEY ("target_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_05AzlOCx8Ebd_fkey" FOREIGN KEY ("invitation_distribution_id") REFERENCES "invitation_distribution"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_invitation_granted_check" CHECK (
        CASE "type"::text
          WHEN 'invitation_granted'
          THEN "invitation_distribution_id" IS NOT NULL
            AND "invitation_amount" IS NOT NULL
            AND "invitation_amount" > 0
          ELSE "invitation_distribution_id" IS NULL
            AND "invitation_amount" IS NULL
        END
      );--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_post_id_check", ADD CONSTRAINT "notification_post_id_check" CHECK (
        CASE "type"::text
          WHEN 'follow' THEN "post_id" IS NULL
          WHEN 'organization_invitation' THEN "post_id" IS NULL
          WHEN 'organization_conversion_request'
          THEN "post_id" IS NULL
          WHEN 'invitation_granted' THEN "post_id" IS NULL
          ELSE "post_id" IS NOT NULL
        END
      );