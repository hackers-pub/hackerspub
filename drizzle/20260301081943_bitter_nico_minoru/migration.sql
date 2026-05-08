CREATE TABLE "article_medium" (
	"key" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"article_draft_id" uuid,
	"article_source_id" uuid,
	"url" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_medium" ADD CONSTRAINT "article_medium_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_medium" ADD CONSTRAINT "article_medium_article_draft_id_article_draft_id_fk" FOREIGN KEY ("article_draft_id") REFERENCES "public"."article_draft"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_medium" ADD CONSTRAINT "article_medium_article_source_id_article_source_id_fk" FOREIGN KEY ("article_source_id") REFERENCES "public"."article_source"("id") ON DELETE set null ON UPDATE no action;