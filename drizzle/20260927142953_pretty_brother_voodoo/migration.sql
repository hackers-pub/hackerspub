CREATE TABLE "account_email_challenge" (
	"token" uuid PRIMARY KEY,
	"account_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_email" ADD COLUMN "primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "email_credentials_changed" timestamp with time zone;--> statement-breakpoint
DROP INDEX "idx_account_email_lower_email";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_email_lower_email" ON "account_email" (lower("email"));--> statement-breakpoint
CREATE INDEX "account_email_challenge_account_created_idx" ON "account_email_challenge" ("account_id","created");--> statement-breakpoint
CREATE INDEX "account_email_challenge_email_created_idx" ON "account_email_challenge" (lower("email"),"created");--> statement-breakpoint
CREATE UNIQUE INDEX "account_email_challenge_active_idx" ON "account_email_challenge" ("account_id") WHERE NOT "used";--> statement-breakpoint
-- Preserve one deterministic verified notification address per account.
WITH first_email AS (
  SELECT DISTINCT ON ("account_id") "email"
  FROM "account_email"
  WHERE "verified" IS NOT NULL
  ORDER BY "account_id", "created", "email"
)
UPDATE "account_email" SET "primary" = true
WHERE "email" IN (SELECT "email" FROM first_email);--> statement-breakpoint
CREATE UNIQUE INDEX "account_email_primary_idx" ON "account_email" ("account_id") WHERE "primary";--> statement-breakpoint
ALTER TABLE "account_email_challenge" ADD CONSTRAINT "account_email_challenge_account_id_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_email" ADD CONSTRAINT "account_email_primary_verified_check" CHECK (NOT "primary" OR "verified" IS NOT NULL);