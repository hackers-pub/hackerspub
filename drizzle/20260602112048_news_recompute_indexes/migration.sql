-- These indexes are created in production with CREATE INDEX CONCURRENTLY before
-- this migration runs (a non-concurrent CREATE INDEX takes a table lock, which
-- is unacceptable on the large `post` table). IF NOT EXISTS makes this a no-op
-- there, while still creating them on fresh/dev/test databases.
CREATE INDEX IF NOT EXISTS "idx_post_news_share_link" ON "post" ("link_id","published") WHERE "link_id" IS NOT NULL AND "shared_post_id" IS NULL AND "visibility" IN ('public', 'unlisted');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_post_news_share_published" ON "post" ("published") WHERE "link_id" IS NOT NULL AND "shared_post_id" IS NULL AND "visibility" IN ('public', 'unlisted');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_post_news_share_updated" ON "post" ("updated") WHERE "link_id" IS NOT NULL AND "shared_post_id" IS NULL AND "visibility" IN ('public', 'unlisted');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reaction_created" ON "reaction" ("created");
