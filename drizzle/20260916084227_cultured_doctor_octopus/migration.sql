ALTER TABLE "article_draft" ADD COLUMN "creator_id" uuid;--> statement-breakpoint
ALTER TABLE "article_draft" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_post_author" ADD COLUMN "publisher_id" uuid;--> statement-breakpoint
-- Backfill: existing drafts are personally owned, so the owner created them.
-- Run this before the foreign keys and again after the old application process
-- has stopped, because the old writer does not set "creator_id".
UPDATE "article_draft"
SET "creator_id" = "account_id"
WHERE "creator_id" IS NULL;--> statement-breakpoint
-- Backfill: the old writer stored the publisher in "member_account_id".
-- Run twice as above for the same deployment-order reason.
UPDATE "organization_post_author"
SET "publisher_id" = "member_account_id"
WHERE "publisher_id" IS NULL;--> statement-breakpoint
CREATE INDEX "article_draft_account_updated_idx" ON "article_draft" ("account_id","updated");--> statement-breakpoint
CREATE INDEX "article_draft_creator_id_idx" ON "article_draft" ("creator_id");--> statement-breakpoint
CREATE INDEX "organization_post_author_publisher_idx" ON "organization_post_author" ("publisher_id");--> statement-breakpoint
ALTER TABLE "article_draft" ADD CONSTRAINT "article_draft_creator_id_account_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "organization_post_author" ADD CONSTRAINT "organization_post_author_publisher_id_account_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "account"("id") ON DELETE SET NULL;
