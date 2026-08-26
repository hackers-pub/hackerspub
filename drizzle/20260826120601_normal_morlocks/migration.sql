-- Create these indexes in production with CREATE INDEX CONCURRENTLY before
-- this migration runs. IF NOT EXISTS makes the migration a no-op there while
-- still creating the indexes on fresh, development, and test databases.
CREATE INDEX IF NOT EXISTS "idx_actor_remote_suspended_until" ON "actor" ("suspended_until") WHERE
        "account_id" IS NULL AND "suspended_until" IS NOT NULL
      ;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_actor_url" ON "actor" ("url") WHERE ("url" is not null);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_actor_aliases_gin" ON "actor" USING gin ("aliases");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_post_link_url_hash" ON "post" USING hash ("link_url") WHERE ("link_url" is not null);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_post_news_boost_updated" ON "post" ("updated") WHERE
        "shared_post_id" IS NOT NULL
          AND "visibility" IN ('public', 'unlisted')
      ;
