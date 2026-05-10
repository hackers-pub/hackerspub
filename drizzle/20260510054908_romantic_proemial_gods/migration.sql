CREATE INDEX IF NOT EXISTS "idx_post_tags_gin" ON "post" USING gin ("tags");
