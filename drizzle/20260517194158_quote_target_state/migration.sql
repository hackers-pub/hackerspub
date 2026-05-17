CREATE TYPE "quote_target_state" AS ENUM('pending', 'denied');--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "quote_target_state" "quote_target_state";--> statement-breakpoint
UPDATE "post"
SET "quote_target_state" = 'pending'
FROM "quote_request"
WHERE
  "quote_request"."quote_post_id" = "post"."id" AND
  "post"."quoted_post_id" IS NULL AND
  "quote_request"."accepted" IS NULL AND
  "quote_request"."rejected" IS NULL;--> statement-breakpoint
UPDATE "post"
SET "quote_target_state" = 'denied'
FROM "quote_request"
WHERE
  "quote_request"."quote_post_id" = "post"."id" AND
  "post"."quoted_post_id" IS NULL AND
  "post"."quote_target_state" IS NULL AND
  "quote_request"."rejected" IS NOT NULL;--> statement-breakpoint
UPDATE "post"
SET "quote_target_state" = 'denied'
FROM "quote_authorization"
WHERE
  "quote_authorization"."quote_post_id" = "post"."id" AND
  "post"."quoted_post_id" IS NULL AND
  "post"."quote_target_state" IS NULL AND
  "quote_authorization"."revoked" = true;
