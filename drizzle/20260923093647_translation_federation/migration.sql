CREATE TYPE "post_translation_freshness" AS ENUM('current', 'source_changed', 'unknown');--> statement-breakpoint
CREATE TYPE "post_translation_kind" AS ENUM('human', 'machine', 'machine_reviewed', 'unknown');--> statement-breakpoint
CREATE TABLE "post_content_variant" (
	"id" uuid PRIMARY KEY,
	"post_id" uuid NOT NULL,
	"language" varchar,
	"default" boolean DEFAULT false NOT NULL,
	"original_language" varchar,
	"url" text,
	"name" text,
	"summary" text,
	"content_html" text NOT NULL,
	"translation_kind" "post_translation_kind",
	"translator_iris" text[] DEFAULT (ARRAY[]::text[])::text[] NOT NULL,
	"freshness" "post_translation_freshness",
	"source_updated" timestamp with time zone,
	CONSTRAINT "post_content_variant_translation_check" CHECK (("translation_kind" IS NULL) = ("freshness" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "article_content" ADD COLUMN "deleted_translator_id" uuid;--> statement-breakpoint
ALTER TABLE "article_source_revision" ADD COLUMN "public_until" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "post_content_variant_post_language_idx" ON "post_content_variant" ("post_id",coalesce("language", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "post_content_variant_post_default_idx" ON "post_content_variant" ("post_id") WHERE "default";--> statement-breakpoint
ALTER TABLE "article_content" ADD CONSTRAINT "article_content_deleted_translator_id_fkey" FOREIGN KEY ("deleted_translator_id") REFERENCES "deleted_account"("account_id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "post_content_variant" ADD CONSTRAINT "post_content_variant_post_id_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE;