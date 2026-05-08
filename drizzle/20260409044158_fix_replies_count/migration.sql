-- Custom SQL migration file, put your code below! --
UPDATE "post"
SET "replies_count" = "subquery"."count"
FROM (
  SELECT "reply_target_id", COUNT(*) AS "count"
  FROM "post"
  WHERE "reply_target_id" IS NOT NULL
  GROUP BY "reply_target_id"
) AS "subquery"
WHERE "post"."id" = "subquery"."reply_target_id"
  AND "post"."replies_count" = 0;