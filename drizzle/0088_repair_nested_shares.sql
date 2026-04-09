CREATE TEMP TABLE "nested_share_repair" AS
SELECT
  "p"."id" AS "share_id",
  "p"."actor_id",
  "p"."shared_post_id" AS "parent_share_id",
  "s"."shared_post_id" AS "original_id",
  EXISTS (
    SELECT 1
    FROM "post" AS "p2"
    WHERE "p2"."actor_id" = "p"."actor_id"
      AND "p2"."shared_post_id" = "s"."shared_post_id"
      AND "p2"."id" <> "p"."id"
  ) AS "has_conflict"
FROM "post" AS "p"
JOIN "post" AS "s" ON "s"."id" = "p"."shared_post_id"
WHERE "p"."shared_post_id" IS NOT NULL
  AND "s"."shared_post_id" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "post" AS "p"
USING "nested_share_repair" AS "r"
WHERE "p"."id" = "r"."share_id"
  AND "r"."has_conflict";
--> statement-breakpoint
UPDATE "post" AS "p"
SET "shared_post_id" = "r"."original_id"
FROM "nested_share_repair" AS "r"
WHERE "p"."id" = "r"."share_id"
  AND NOT "r"."has_conflict";
--> statement-breakpoint
CREATE TEMP TABLE "share_count_repair" AS
SELECT
  "shared_post_id" AS "post_id",
  count(*)::integer AS "shares_count"
FROM "post"
WHERE "shared_post_id" IS NOT NULL
GROUP BY "shared_post_id";
--> statement-breakpoint
UPDATE "post"
SET "shares_count" = 0
WHERE "shares_count" <> 0;
--> statement-breakpoint
UPDATE "post" AS "p"
SET "shares_count" = "c"."shares_count"
FROM "share_count_repair" AS "c"
WHERE "p"."id" = "c"."post_id";
--> statement-breakpoint
DROP TABLE "share_count_repair";
--> statement-breakpoint
DROP TABLE "nested_share_repair";
