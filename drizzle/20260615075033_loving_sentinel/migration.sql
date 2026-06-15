-- Created in production with CREATE INDEX CONCURRENTLY before this migration
-- runs to avoid locking the large `post` table. Fresh/dev/test databases can
-- create it normally here.
CREATE INDEX IF NOT EXISTS "idx_post_public_top_level_candidate" ON "post" ("visibility","published"::timestamptz(3) desc,"id" desc,"published","censored","actor_id","shared_post_id") WHERE "reply_target_id" IS NULL;
