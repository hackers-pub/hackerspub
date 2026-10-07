CREATE TABLE "account_recovery_code" (
	"account_id" uuid,
	"code_hash" text,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"used" timestamp with time zone,
	CONSTRAINT "account_recovery_code_pkey" PRIMARY KEY("account_id","code_hash")
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "email_login_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "email_session_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_recovery_code" ADD CONSTRAINT "account_recovery_code_account_id_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE;