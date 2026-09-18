CREATE TYPE "article_content_provenance" AS ENUM('human', 'llm', 'llm_reviewed', 'unknown');--> statement-breakpoint
CREATE TYPE "article_translation_draft_provenance" AS ENUM('human', 'llm', 'unknown');--> statement-breakpoint
CREATE TABLE "article_source_revision" (
	"id" uuid PRIMARY KEY,
	"article_draft_id" uuid,
	"source_id" uuid,
	"language" varchar NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "article_source_revision_owner_check" CHECK (("article_draft_id" IS NULL) <> ("source_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "article_translation_draft_medium" (
	"article_translation_draft_id" uuid,
	"key" text,
	"medium_id" uuid NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "article_translation_draft_medium_pkey" PRIMARY KEY("article_translation_draft_id","key")
);
--> statement-breakpoint
CREATE TABLE "article_translation_draft" (
	"id" uuid PRIMARY KEY,
	"article_draft_id" uuid,
	"source_id" uuid,
	"language" varchar NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"translator_id" uuid,
	"provenance" "article_translation_draft_provenance" DEFAULT 'human'::"article_translation_draft_provenance" NOT NULL,
	"source_revision_id" uuid,
	"published_revision" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "article_translation_draft_draft_language_unique" UNIQUE("article_draft_id","language"),
	CONSTRAINT "article_translation_draft_source_language_unique" UNIQUE("source_id","language"),
	CONSTRAINT "article_translation_draft_owner_check" CHECK (("article_draft_id" IS NULL) <> ("source_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "article_content" ADD COLUMN "provenance" "article_content_provenance";--> statement-breakpoint
ALTER TABLE "article_content" ADD COLUMN "source_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "article_content" ADD COLUMN "translation_job_token" uuid;--> statement-breakpoint
ALTER TABLE "article_draft" ADD COLUMN "language" varchar;--> statement-breakpoint
-- Backfill provenance by evidence only. A row with a human translator is
-- human-managed; a row with a requester is automatic; a row with neither (for
-- example because the account was deleted) stays `unknown` so that a later LLM
-- job cannot treat it as its own and overwrite it.
UPDATE "article_content"
SET "provenance" = CASE
	WHEN "translator_id" IS NOT NULL THEN 'human'
	WHEN "translation_requester_id" IS NOT NULL THEN 'llm'
	ELSE 'unknown'
END::"article_content_provenance"
WHERE "original_language" IS NOT NULL AND "provenance" IS NULL;--> statement-breakpoint
-- Pre-check before deploying against a database that may predate this
-- invariant; the index creation aborts if any source already has more than one
-- original-language content row:
--   SELECT source_id, count(*) FROM article_content
--   WHERE original_language IS NULL GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX "article_content_single_original_idx" ON "article_content" ("source_id") WHERE ("original_language" is null);--> statement-breakpoint
-- Seed one snapshot per existing published source from its current original and
-- point the original at it, so newly created translations have a baseline to
-- start from. This records current content; it does not fabricate a review.
INSERT INTO "article_source_revision" ("id", "source_id", "language", "title", "content", "created")
SELECT gen_random_uuid(), c."source_id", c."language", c."title", c."content", c."published"
FROM "article_content" c
WHERE c."original_language" IS NULL;--> statement-breakpoint
UPDATE "article_content" c
SET "source_revision_id" = r."id"
FROM "article_source_revision" r
WHERE r."source_id" = c."source_id" AND c."original_language" IS NULL;--> statement-breakpoint
CREATE INDEX "article_source_revision_draft_idx" ON "article_source_revision" ("article_draft_id","created","id");--> statement-breakpoint
CREATE INDEX "article_source_revision_source_idx" ON "article_source_revision" ("source_id","created","id");--> statement-breakpoint
CREATE INDEX "article_translation_draft_medium_medium_id_idx" ON "article_translation_draft_medium" ("medium_id");--> statement-breakpoint
CREATE INDEX "article_translation_draft_draft_idx" ON "article_translation_draft" ("article_draft_id","updated");--> statement-breakpoint
CREATE INDEX "article_translation_draft_source_idx" ON "article_translation_draft" ("source_id","updated");--> statement-breakpoint
ALTER TABLE "article_content" ADD CONSTRAINT "article_content_ciyepqSfUz9J_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "article_source_revision"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "article_source_revision" ADD CONSTRAINT "article_source_revision_article_draft_id_article_draft_id_fkey" FOREIGN KEY ("article_draft_id") REFERENCES "article_draft"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_source_revision" ADD CONSTRAINT "article_source_revision_source_id_article_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "article_source"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_translation_draft_medium" ADD CONSTRAINT "article_translation_draft_medium_LzOyaa8kT18m_fkey" FOREIGN KEY ("article_translation_draft_id") REFERENCES "article_translation_draft"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_translation_draft_medium" ADD CONSTRAINT "article_translation_draft_medium_medium_id_medium_id_fkey" FOREIGN KEY ("medium_id") REFERENCES "medium"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "article_translation_draft" ADD CONSTRAINT "article_translation_draft_cQfdRnohd3sq_fkey" FOREIGN KEY ("article_draft_id") REFERENCES "article_draft"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_translation_draft" ADD CONSTRAINT "article_translation_draft_source_id_article_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "article_source"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_translation_draft" ADD CONSTRAINT "article_translation_draft_translator_id_account_id_fkey" FOREIGN KEY ("translator_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "article_translation_draft" ADD CONSTRAINT "article_translation_draft_WJbeMKSyiR6f_fkey" FOREIGN KEY ("source_revision_id") REFERENCES "article_source_revision"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "article_content" ADD CONSTRAINT "article_content_provenance_check" CHECK ("original_language" IS NULL OR "provenance" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "article_content" DROP CONSTRAINT "article_content_original_language_check", ADD CONSTRAINT "article_content_original_language_check" CHECK ("original_language" IS NOT NULL OR (
        "translator_id" IS NULL AND
        "translation_requester_id" IS NULL AND
        "provenance" IS NULL
      ));