-- Create this index in production with CREATE INDEX CONCURRENTLY before this
-- migration runs. IF NOT EXISTS makes the migration a no-op there while still
-- creating the index on fresh, development, and test databases.
CREATE INDEX IF NOT EXISTS "idx_post_link_url_latest" ON "post" (md5("link_url"),"updated" desc) WHERE ("link_url" is not null);
