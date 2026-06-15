-- Created in production with CREATE INDEX CONCURRENTLY before this migration
-- runs to avoid locking the large `post` table.  Fresh/dev/test databases can
-- create it normally here.
CREATE INDEX IF NOT EXISTS "idx_post_actor_id_updated" ON "post" ("actor_id","updated" desc);
