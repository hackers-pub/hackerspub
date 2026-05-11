CREATE INDEX "idx_post_public_local_published" ON "post" ("visibility","published" desc,"id" desc,"language") WHERE 
        "reply_target_id" IS NULL
        AND (
          "note_source_id" IS NOT NULL
          OR "article_source_id" IS NOT NULL
          OR "shared_post_id" IS NOT NULL
        )
      ;
