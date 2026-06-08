CREATE INDEX "idx_post_actor_id_published_ms" ON "post" ("actor_id",("published"::timestamptz(3)) desc,"id" desc) WHERE ("shared_post_id" is null);
