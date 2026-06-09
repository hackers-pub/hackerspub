-- In production, create this index with CREATE INDEX CONCURRENTLY before this
-- migration runs.  The IF NOT EXISTS form then makes this migration a no-op.
CREATE INDEX IF NOT EXISTS "idx_post_article_link_published"
ON "post" ("link_id", "published")
WHERE "type" = 'Article'
  AND "link_id" IS NOT NULL
  AND "shared_post_id" IS NULL
  AND "reply_target_id" IS NULL
  AND "quoted_post_id" IS NULL;
