WITH affected_posts AS (
  SELECT DISTINCT
    "post"."id" AS "post_id",
    "post"."link_id"
  FROM "post"
  INNER JOIN "post_link"
    ON "post_link"."id" = "post"."link_id"
  INNER JOIN "mention"
    ON "mention"."post_id" = "post"."id"
  INNER JOIN "actor"
    ON "actor"."id" = "mention"."actor_id"
  WHERE
    "post"."link_id" IS NOT NULL
    AND (
      "post"."link_url" = "actor"."iri"
      OR "post"."link_url" = "actor"."url"
      OR "post"."link_url" = ANY("actor"."aliases")
      OR "post_link"."url" = "actor"."iri"
      OR "post_link"."url" = "actor"."url"
      OR "post_link"."url" = ANY("actor"."aliases")
    )
),
cleared_posts AS (
  UPDATE "post"
  SET
    "link_id" = NULL,
    "link_url" = NULL
  FROM affected_posts
  WHERE "post"."id" = affected_posts."post_id"
  RETURNING affected_posts."link_id"
)
UPDATE "post_link"
SET
  "score" = 0,
  "weighted_mass" = 0,
  "recency_component" = 0,
  "post_count" = 0,
  "first_shared_at" = NULL,
  "latest_activity_at" = NULL,
  "score_updated" = CURRENT_TIMESTAMP
WHERE
  "post_link"."id" IN (SELECT "link_id" FROM cleared_posts)
  AND NOT EXISTS (
    SELECT 1
    FROM "post"
    WHERE "post"."link_id" = "post_link"."id"
  );
