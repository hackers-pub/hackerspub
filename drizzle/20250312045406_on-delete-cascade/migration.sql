ALTER TABLE "account_email" DROP CONSTRAINT "account_email_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "account_key" DROP CONSTRAINT "account_key_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "account_link" DROP CONSTRAINT "account_link_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "actor" DROP CONSTRAINT "actor_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "article_draft" DROP CONSTRAINT "article_draft_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "article_draft" DROP CONSTRAINT "article_draft_article_source_id_article_source_id_fk";
--> statement-breakpoint
ALTER TABLE "article_source" DROP CONSTRAINT "article_source_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "following" DROP CONSTRAINT "following_follower_id_actor_id_fk";
--> statement-breakpoint
ALTER TABLE "following" DROP CONSTRAINT "following_followee_id_actor_id_fk";
--> statement-breakpoint
ALTER TABLE "note_source" DROP CONSTRAINT "note_source_account_id_account_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_email" ADD CONSTRAINT "account_email_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_key" ADD CONSTRAINT "account_key_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_link" ADD CONSTRAINT "account_link_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "actor" ADD CONSTRAINT "actor_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_draft" ADD CONSTRAINT "article_draft_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_draft" ADD CONSTRAINT "article_draft_article_source_id_article_source_id_fk" FOREIGN KEY ("article_source_id") REFERENCES "public"."article_source"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_source" ADD CONSTRAINT "article_source_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "following" ADD CONSTRAINT "following_follower_id_actor_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "following" ADD CONSTRAINT "following_followee_id_actor_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "note_source" ADD CONSTRAINT "note_source_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
