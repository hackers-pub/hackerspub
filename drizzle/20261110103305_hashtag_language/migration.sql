-- One statement keeps the locks, backfill and old-writer synchronization
-- atomic even when the migration runner splits statement breakpoints.
DO $migration$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "post" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE "post_hashtag" IN ACCESS EXCLUSIVE MODE;

  ALTER TABLE "post_hashtag" ADD COLUMN "language" varchar;
  -- Avoid maintaining the old secondary index during the backfill.
  DROP INDEX "idx_post_hashtag_tag_published";
  UPDATE "post_hashtag" AS h SET "language" = p."language"
  FROM "post" AS p
  WHERE h."post_id" = p."id" AND p."language" IS NOT NULL;

  CREATE OR REPLACE FUNCTION "sync_post_hashtags"() RETURNS trigger
  LANGUAGE plpgsql AS $sync$
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF OLD."tags" IS NOT DISTINCT FROM NEW."tags" THEN
        UPDATE "post_hashtag"
        SET "published" = NEW."published", "language" = NEW."language"
        WHERE "post_id" = NEW."id";
        RETURN NEW;
      END IF;
      DELETE FROM "post_hashtag" WHERE "post_id" = NEW."id";
    END IF;

    INSERT INTO "post_hashtag" ("post_id", "tag_hash", "published", "language")
    SELECT NEW."id", hashes."tag_hash", NEW."published", NEW."language"
    FROM "post_hashtag_hashes"(NEW."tags") AS hashes("tag_hash");
    RETURN NEW;
  END;
  $sync$;

  -- Replacing the trigger avoids DROP TRIGGER's stronger lock on post.
  CREATE OR REPLACE TRIGGER "trg_update_post_hashtags"
    AFTER UPDATE OF "tags", "published", "language" ON "post"
    FOR EACH ROW WHEN (
      OLD."tags" IS DISTINCT FROM NEW."tags"
      OR OLD."published" IS DISTINCT FROM NEW."published"
      OR OLD."language" IS DISTINCT FROM NEW."language"
    )
    EXECUTE FUNCTION "sync_post_hashtags"();

  -- Preserve global publication order across expanded locales. The trailing
  -- language prefix bounds keys even for very long BCP 47 private-use tags.
  -- Complete source language checks remain authoritative.
  CREATE INDEX "idx_post_hashtag_tag_published" ON "post_hashtag"
    ("tag_hash", "published" DESC, "post_id", left("language", 64));
  ANALYZE "post_hashtag";
END;
$migration$;
