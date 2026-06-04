CREATE TABLE "news_preferred_sharer" (
	"id" uuid PRIMARY KEY,
	"actor_id" uuid NOT NULL UNIQUE,
	"bonus" double precision NOT NULL,
	"note" text,
	"creator_id" uuid,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_link" ADD COLUMN "promotion_bonus" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "news_preferred_sharer_creator_id_index" ON "news_preferred_sharer" ("creator_id");--> statement-breakpoint
ALTER TABLE "news_preferred_sharer" ADD CONSTRAINT "news_preferred_sharer_actor_id_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actor"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "news_preferred_sharer" ADD CONSTRAINT "news_preferred_sharer_creator_id_account_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "account"("id") ON DELETE SET NULL;