-- Created in production with CREATE INDEX CONCURRENTLY before this migration
-- runs to avoid locking the large `post` table. Fresh/dev/test databases can
-- create these normally here.
CREATE INDEX IF NOT EXISTS "idx_post_public_local_note_published" ON "post" ("visibility","published"::timestamptz(3) desc,"id" desc,"language") WHERE 
        "reply_target_id" IS NULL
        AND "note_source_id" IS NOT NULL
      ;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_post_public_local_article_published" ON "post" ("visibility","published"::timestamptz(3) desc,"id" desc,"language") WHERE 
        "reply_target_id" IS NULL
        AND "article_source_id" IS NOT NULL
      ;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_post_actor_shared_published_ms" ON "post" ("actor_id","published"::timestamptz(3) desc,"id" desc) WHERE 
        "reply_target_id" IS NULL
        AND "shared_post_id" IS NOT NULL
      ;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_post_link_id_censored_actor_id" ON "post" ("link_id","censored","actor_id") WHERE ("link_id" is not null);
