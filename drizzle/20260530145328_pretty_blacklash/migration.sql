CREATE TABLE "news_excluded_pattern" (
	"id" uuid PRIMARY KEY,
	"pattern" text NOT NULL UNIQUE,
	"note" text,
	"creator_id" uuid,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_link" ADD COLUMN "score_penalty" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_link" ADD COLUMN "excluded_from_news" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "news_excluded_pattern_creator_id_index" ON "news_excluded_pattern" ("creator_id");--> statement-breakpoint
ALTER TABLE "news_excluded_pattern" ADD CONSTRAINT "news_excluded_pattern_creator_id_account_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "account"("id") ON DELETE SET NULL;