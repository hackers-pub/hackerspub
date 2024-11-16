CREATE TABLE IF NOT EXISTS "article_source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"published_year" smallint DEFAULT EXTRACT(year FROM CURRENT_TIMESTAMP) NOT NULL,
	"slug" varchar(128) NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"tags" text[] DEFAULT (ARRAY[]::text[]) NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"published" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_draft" ADD COLUMN "article_source_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_source" ADD CONSTRAINT "article_source_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_draft" ADD CONSTRAINT "article_draft_article_source_id_article_source_id_fk" FOREIGN KEY ("article_source_id") REFERENCES "public"."article_source"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
