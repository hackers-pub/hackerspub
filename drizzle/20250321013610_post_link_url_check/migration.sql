UPDATE "post"
SET "link_id" = NULL, "link_url" = NULL
WHERE "post"."link_id" NOT IN (
  SELECT "post_link"."id"
  FROM "post_link"
  WHERE "post_link"."url" ~ '^https?://'
  AND ("post_link"."image_url" IS NULL OR "post_link"."image_url" ~ '^https?://')
);--> statement-breakpoint
DELETE FROM "post_link"
WHERE NOT ("post_link"."url" ~ '^https?://')
OR "post_link"."image_url" IS NOT NULL
AND NOT ("post_link"."image_url" ~ '^https?://');--> statement-breakpoint
ALTER TABLE "post_link" ADD CONSTRAINT "post_link_url_check" CHECK ("post_link"."url" ~ '^https?://');--> statement-breakpoint
ALTER TABLE "post_link" ADD CONSTRAINT "post_link_image_url_check" CHECK ("post_link"."image_url" ~ '^https?://');
