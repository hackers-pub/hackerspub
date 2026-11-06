-- Keep this migration in ONE statement: drizzle-kit may execute breakpoint
-- chunks in separate implicit transactions. The source lock must cover both
-- the backfill snapshot and installing synchronization for old/new writers.
DO $migration$
BEGIN
  LOCK TABLE "post" IN SHARE ROW EXCLUSIVE MODE;

  CREATE TABLE "post_hashtag" (
    "post_id" uuid NOT NULL,
    "tag_hash" uuid NOT NULL,
    "published" timestamp with time zone NOT NULL
  );

  -- Mirror JSONB key existence, including top-level string arrays/scalars.
  -- Hash exact stored strings, not lowercased keys. Queries retain the exact
  -- existence recheck, so hash collisions only produce extra candidates.
  CREATE FUNCTION "post_hashtag_hashes"(tags jsonb) RETURNS SETOF uuid
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $hashes$
    SELECT DISTINCT md5(token)::uuid
    FROM (
      SELECT jsonb_object_keys(
        CASE WHEN jsonb_typeof(tags) = 'object' THEN tags ELSE '{}'::jsonb END
      ) AS token
      UNION ALL
      SELECT element #>> '{}' AS token
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END
      ) AS elements(element)
      WHERE jsonb_typeof(element) = 'string'
      UNION ALL
      SELECT tags #>> '{}' AS token
      WHERE jsonb_typeof(tags) = 'string'
    ) AS tokens
  $hashes$;

  INSERT INTO "post_hashtag" ("post_id", "tag_hash", "published")
  SELECT p."id", hashes."tag_hash", p."published"
  FROM "post" AS p
  CROSS JOIN LATERAL "post_hashtag_hashes"(p."tags") AS hashes("tag_hash");

  -- Build indexes after bulk loading to shorten the write-lock window.
  ALTER TABLE "post_hashtag" ADD CONSTRAINT "post_hashtag_pkey"
    PRIMARY KEY ("post_id", "tag_hash");
  ALTER TABLE "post_hashtag" ADD CONSTRAINT "post_hashtag_post_id_post_id_fkey"
    FOREIGN KEY ("post_id") REFERENCES "post"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  CREATE INDEX "idx_post_hashtag_tag_published" ON "post_hashtag"
    ("tag_hash", "published" DESC, "post_id");

  CREATE FUNCTION "sync_post_hashtags"() RETURNS trigger
  LANGUAGE plpgsql AS $sync$
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF OLD."tags" IS NOT DISTINCT FROM NEW."tags" THEN
        UPDATE "post_hashtag" SET "published" = NEW."published"
        WHERE "post_id" = NEW."id";
        RETURN NEW;
      END IF;
      DELETE FROM "post_hashtag" WHERE "post_id" = NEW."id";
    END IF;

    INSERT INTO "post_hashtag" ("post_id", "tag_hash", "published")
    SELECT NEW."id", hashes."tag_hash", NEW."published"
    FROM "post_hashtag_hashes"(NEW."tags") AS hashes("tag_hash");
    RETURN NEW;
  END;
  $sync$;

  CREATE TRIGGER "trg_insert_post_hashtags"
    AFTER INSERT ON "post"
    FOR EACH ROW WHEN (NEW."tags" <> '{}'::jsonb)
    EXECUTE FUNCTION "sync_post_hashtags"();
  CREATE TRIGGER "trg_update_post_hashtags"
    AFTER UPDATE OF "tags", "published" ON "post"
    FOR EACH ROW WHEN (
      OLD."tags" IS DISTINCT FROM NEW."tags"
      OR OLD."published" IS DISTINCT FROM NEW."published"
    )
    EXECUTE FUNCTION "sync_post_hashtags"();

  ANALYZE "post_hashtag";
END;
$migration$;
