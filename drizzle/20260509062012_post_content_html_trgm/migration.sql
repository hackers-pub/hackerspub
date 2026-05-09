CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_post_content_html_trgm" ON "post" USING gin ("content_html" gin_trgm_ops);