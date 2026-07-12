-- Created in production with CREATE INDEX CONCURRENTLY before this migration
-- runs to avoid locking the large `post` table. Fresh/dev/test databases can
-- create it normally here.
CREATE INDEX IF NOT EXISTS "idx_post_outbox_actor_id_id" ON "post" ("actor_id","id" desc) WHERE
        "censored" IS NULL
        AND "visibility" IN ('public', 'unlisted')
      ;
