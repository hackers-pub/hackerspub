ALTER TABLE "allowed_email" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "allowed_email" CASCADE;--> statement-breakpoint
ALTER TABLE "post" DROP CONSTRAINT "post_reply_target_id_post_id_fk";
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "quoted_post_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post" ADD CONSTRAINT "post_quoted_post_id_post_id_fk" FOREIGN KEY ("quoted_post_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post" ADD CONSTRAINT "post_reply_target_id_post_id_fk" FOREIGN KEY ("reply_target_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
