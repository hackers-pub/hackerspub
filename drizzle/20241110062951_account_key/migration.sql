CREATE TYPE "public"."account_key_type" AS ENUM('Ed25519', 'RSASSA-PKCS1-v1_5');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_key" (
	"account_id" uuid NOT NULL,
	"type" "account_key_type" NOT NULL,
	"public" jsonb NOT NULL,
	"private" jsonb NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "account_key_account_id_type_pk" PRIMARY KEY("account_id","type"),
	CONSTRAINT "account_key_public_check" CHECK ("account_key"."public" IS JSON OBJECT),
	CONSTRAINT "account_key_private_check" CHECK ("account_key"."private" IS JSON OBJECT)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_key" ADD CONSTRAINT "account_key_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "account_email" DROP COLUMN IF EXISTS "updated";--> statement-breakpoint
ALTER TABLE "account_email" DROP COLUMN IF EXISTS "deleted";--> statement-breakpoint
ALTER TABLE "account_link" DROP COLUMN IF EXISTS "updated";--> statement-breakpoint
ALTER TABLE "account_link" DROP COLUMN IF EXISTS "deleted";