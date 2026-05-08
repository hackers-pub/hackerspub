ALTER TABLE "passkey" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_name_check" CHECK ("passkey"."name" !~ '^[[:space:]]*$');