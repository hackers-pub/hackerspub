ALTER TABLE "account" ADD COLUMN "inviter_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account" ADD CONSTRAINT "account_inviter_id_account_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
