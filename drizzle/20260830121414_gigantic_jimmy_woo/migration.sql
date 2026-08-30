-- Create this index in production with CREATE INDEX CONCURRENTLY before this
-- migration runs. IF NOT EXISTS makes the migration a no-op there while still
-- creating the index on fresh, development, and test databases.
CREATE INDEX IF NOT EXISTS "idx_post_url_hash" ON "post" USING hash ("url") WHERE ("url" is not null);
