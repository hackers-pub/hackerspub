WITH candidates AS (
  SELECT
    p.id AS post_id,
    CASE
      WHEN p.url ~ '^https?://' THEN p.url
      ELSE p.iri
    END AS article_url,
    p.name,
    p.summary,
    p.content_html,
    p.link_id AS old_link_id,
    p.published,
    p.updated,
    a.id AS actor_id,
    a.username,
    a.name AS actor_name
  FROM "post" p
  INNER JOIN "actor" a ON a.id = p.actor_id
  WHERE
    p.type = 'Article'
    AND p.visibility IN ('public', 'unlisted')
    AND p.shared_post_id IS NULL
    AND p.reply_target_id IS NULL
    AND p.quoted_post_id IS NULL
    AND (
      p.url ~ '^https?://'
      OR p.iri ~ '^https?://'
    )
),
upserted_links AS (
  INSERT INTO "post_link" (
    "id",
    "url",
    "title",
    "site_name",
    "type",
    "description",
    "author",
    "creator_id",
    "created",
    "scraped"
  )
  SELECT
    gen_random_uuid(),
    article_url,
    name,
    replace(split_part(article_url, '/', 3), 'www.', ''),
    'article',
    left(
      btrim(
        regexp_replace(
          COALESCE(
            NULLIF(summary, ''),
            regexp_replace(content_html, '<[^>]+>', ' ', 'g')
          ),
          '\s+',
          ' ',
          'g'
        )
      ),
      500
    ),
    COALESCE(NULLIF(actor_name, ''), username),
    actor_id,
    LEAST(published, updated),
    CURRENT_TIMESTAMP
  FROM candidates
  ON CONFLICT ("url") DO UPDATE SET
    "title" = EXCLUDED."title",
    "site_name" = EXCLUDED."site_name",
    "type" = EXCLUDED."type",
    "description" = EXCLUDED."description",
    "author" = EXCLUDED."author",
    "creator_id" = EXCLUDED."creator_id",
    "scraped" = CURRENT_TIMESTAMP
  RETURNING "id", "url"
),
linked_posts AS (
  UPDATE "post" p
  SET
    "link_id" = pl.id,
    "link_url" = pl.url
  FROM candidates c
  INNER JOIN upserted_links pl ON pl.url = c.article_url
  WHERE p.id = c.post_id
  RETURNING p.link_id, c.old_link_id
),
scored AS (
  WITH share_roots AS (
    SELECT
      p.link_id,
      p.actor_id,
      p.published
    FROM "post" p
    WHERE
      p.link_id IN (SELECT link_id FROM linked_posts)
      AND p.visibility IN ('public', 'unlisted')
      AND p.shared_post_id IS NULL
    UNION ALL
    SELECT
      original.link_id,
      p.actor_id,
      p.published
    FROM "post" p
    INNER JOIN "post" original ON original.id = p.shared_post_id
    WHERE
      original.link_id IN (SELECT link_id FROM linked_posts)
      AND original.type = 'Article'
      AND original.visibility IN ('public', 'unlisted')
      AND p.visibility IN ('public', 'unlisted')
  )
  SELECT
    sr.link_id,
    count(*) AS post_count,
    min(sr.published) AS first_shared_at,
    max(sr.published) AS latest_activity_at
  FROM share_roots sr
  INNER JOIN "actor" a ON a.id = sr.actor_id
  WHERE
    a.type::text NOT IN ('Service', 'Application')
  GROUP BY sr.link_id
),
scored_links AS (
  UPDATE "post_link" pl
  SET
    "post_count" = scored.post_count,
    "first_shared_at" = scored.first_shared_at,
    "latest_activity_at" = scored.latest_activity_at,
    "weighted_mass" = scored.post_count,
    "recency_component" =
      (extract(epoch from scored.latest_activity_at) - 1704067200::double precision)
        / 50000::double precision,
    "score" =
      log(greatest(1::double precision, scored.post_count::double precision))
      + (extract(epoch from scored.latest_activity_at) - 1704067200::double precision)
        / 50000::double precision
      - pl.score_penalty,
    "score_updated" = CURRENT_TIMESTAMP
  FROM scored
  WHERE pl.id = scored.link_id
  RETURNING pl.id
),
score_backfill AS (
  SELECT count(*) AS count FROM scored_links
)
UPDATE "post_link" pl
SET
  "score" = 0,
  "weighted_mass" = 0,
  "recency_component" = 0,
  "promotion_bonus" = 0,
  "post_count" = 0,
  "first_shared_at" = NULL,
  "latest_activity_at" = NULL,
  "score_updated" = CURRENT_TIMESTAMP
WHERE
  (SELECT count FROM score_backfill) IS NOT NULL
  AND
  pl.id IN (
    SELECT DISTINCT old_link_id
    FROM linked_posts
    WHERE old_link_id IS NOT NULL
      AND old_link_id <> link_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "post" p
    INNER JOIN "actor" a ON a.id = p.actor_id
    WHERE
      p.link_id = pl.id
      AND p.visibility IN ('public', 'unlisted')
      AND p.shared_post_id IS NULL
      AND a.type::text NOT IN ('Service', 'Application')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "post" p
    INNER JOIN "post" original ON original.id = p.shared_post_id
    INNER JOIN "actor" a ON a.id = p.actor_id
    WHERE
      original.link_id = pl.id
      AND original.type = 'Article'
      AND original.visibility IN ('public', 'unlisted')
      AND p.visibility IN ('public', 'unlisted')
      AND a.type::text NOT IN ('Service', 'Application')
  );
