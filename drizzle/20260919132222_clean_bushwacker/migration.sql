ALTER TYPE "notification_type" ADD VALUE 'article_translation_source_changed';--> statement-breakpoint
ALTER TABLE "article_content" ADD COLUMN "reviewer_id" uuid;--> statement-breakpoint
ALTER TABLE "article_content" ADD COLUMN "reviewed" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "article_draft" ADD COLUMN "current_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "article_translation_draft" ADD COLUMN "reviewer_id" uuid;--> statement-breakpoint
ALTER TABLE "article_translation_draft" ADD COLUMN "reviewed" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "article_source_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "translation_languages" text[] DEFAULT (ARRAY[]::text[])::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "article_draft_current_revision_idx" ON "article_draft" ("current_revision_id");--> statement-breakpoint
CREATE INDEX "notification_article_source_revision_id_index" ON "notification" ("article_source_revision_id") WHERE ("article_source_revision_id" is not null);--> statement-breakpoint
ALTER TABLE "article_content" ADD CONSTRAINT "article_content_reviewer_id_account_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "article_draft" ADD CONSTRAINT "article_draft_nAXF9wM2TGyD_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "article_source_revision"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "article_translation_draft" ADD CONSTRAINT "article_translation_draft_reviewer_id_account_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_krlMoBQDr7fJ_fkey" FOREIGN KEY ("article_source_revision_id") REFERENCES "article_source_revision"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_content" ADD CONSTRAINT "article_content_review_check" CHECK ((
        "original_language" IS NOT NULL
        OR ("reviewer_id" IS NULL AND "reviewed" IS NULL)
      )
        AND ("reviewer_id" IS NULL OR "reviewed" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "article_translation_draft" ADD CONSTRAINT "article_translation_draft_review_check" CHECK ("reviewer_id" IS NULL OR "reviewed" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_article_translation_source_changed_check" CHECK (
        CASE "type"::text
          WHEN 'article_translation_source_changed'
          THEN "article_source_revision_id" IS NOT NULL
            AND cardinality("translation_languages") > 0
          ELSE "article_source_revision_id" IS NULL
            AND cardinality("translation_languages") = 0
        END
      );--> statement-breakpoint
-- Point every existing draft at the snapshot its current text corresponds to.
-- Freshness must not depend on `created` ordering (`CURRENT_TIMESTAMP` is the
-- transaction start time and can invert against lock acquisition order), so
-- the pointer is authoritative from here on; this seeds it from the newest
-- matching snapshot each draft already owns.
UPDATE "article_draft" AS d
SET "current_revision_id" = (
  SELECT r."id"
  FROM "article_source_revision" AS r
  WHERE r."article_draft_id" = d."id"
    AND r."title" = d."title"
    AND r."content" = d."content"
    AND r."language" = d."language"
  ORDER BY r."created" DESC, r."id" DESC
  LIMIT 1
)
WHERE d."language" IS NOT NULL;--> statement-breakpoint
-- Give published articles that already have translations a current snapshot,
-- so an authorized reviewer has a revision to acknowledge and the comparison
-- pane has something to render. Articles with no translations are left alone
-- and record their first snapshot on the next edit or translation draft,
-- which keeps this migration from copying every article body in the database.
--
-- Only the original row's baseline is established. Translations keep a null
-- baseline and therefore read as an unknown baseline: no historical review
-- evidence is invented for them.
WITH "targets" AS (
  SELECT DISTINCT o."source_id", o."language", o."title", o."content"
  FROM "article_content" AS o
  WHERE o."original_language" IS NULL
    AND o."source_revision_id" IS NULL
    AND EXISTS (
      SELECT 1
      FROM "article_content" AS t
      WHERE t."source_id" = o."source_id"
        AND t."original_language" IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "article_source_revision" AS r
      WHERE r."source_id" = o."source_id"
    )
), "inserted" AS (
  INSERT INTO "article_source_revision"
    ("id", "article_draft_id", "source_id", "language", "title", "content")
  SELECT
    gen_random_uuid(),
    NULL,
    "source_id",
    "language",
    "title",
    "content"
  FROM "targets"
  RETURNING "id", "source_id"
)
UPDATE "article_content" AS c
SET "source_revision_id" = i."id"
FROM "inserted" AS i
WHERE c."source_id" = i."source_id"
  AND c."original_language" IS NULL;
