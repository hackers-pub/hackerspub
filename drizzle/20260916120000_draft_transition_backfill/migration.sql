-- The cutover documented in DEPLOYMENT.md runs migrations once and only
-- restarts the worker, API, and web UI afterwards. During that window the old
-- API keeps inserting `article_draft` and `organization_post_author` rows and
-- cannot know about the columns added by the previous migration, so those rows
-- would keep `NULL` `creator_id` or `publisher_id` forever. Default the columns
-- from what the old writer does set: a draft's creator is its personal owner,
-- and an organization post's publisher is the member it records. This is
-- idempotent with the new writer, which sets both columns explicitly.
CREATE FUNCTION "fill_article_draft_creator_id"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."creator_id" IS NULL THEN
    NEW."creator_id" := NEW."account_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "trg_fill_article_draft_creator_id"
  BEFORE INSERT ON "article_draft"
  FOR EACH ROW
  EXECUTE FUNCTION "fill_article_draft_creator_id"();--> statement-breakpoint

CREATE FUNCTION "fill_organization_post_author_publisher_id"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."publisher_id" IS NULL THEN
    NEW."publisher_id" := NEW."member_account_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "trg_fill_organization_post_author_publisher_id"
  BEFORE INSERT ON "organization_post_author"
  FOR EACH ROW
  EXECUTE FUNCTION "fill_organization_post_author_publisher_id"();--> statement-breakpoint

-- Also catch rows the old writer inserted after the previous migration ran but
-- before this one, so the columns are consistent by the time the new code
-- takes over.
UPDATE "article_draft"
SET "creator_id" = "account_id"
WHERE "creator_id" IS NULL;--> statement-breakpoint
UPDATE "organization_post_author"
SET "publisher_id" = "member_account_id"
WHERE "publisher_id" IS NULL;
