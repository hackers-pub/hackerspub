ALTER TABLE "timeline_item" ADD COLUMN "appended" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
DELETE FROM timeline_item;--> statement-breakpoint

-- Optimized timeline item population query
-- Using temporary tables in memory for better performance than CTE
-- Breaking down complex OR-condition JOIN into separate operations with indexes

-- Create temporary table to collect all timeline candidates
CREATE TEMPORARY TABLE timeline_candidates (
  account_id UUID NOT NULL,
  post_id UUID NOT NULL,
  original_author_id UUID,
  sharer_id UUID,
  is_shared INT,
  published TIMESTAMPTZ
) ON COMMIT DROP;--> statement-breakpoint

-- Create index on the temp table for faster aggregation
CREATE INDEX ON timeline_candidates (account_id, post_id);--> statement-breakpoint

-- 1. Insert posts from followed accounts
INSERT INTO timeline_candidates
SELECT
  account.id AS account_id,
  COALESCE(post.shared_post_id, post.id) AS post_id,
  CASE WHEN post.shared_post_id IS NULL THEN post.actor_id ELSE NULL END AS original_author_id,
  CASE WHEN post.shared_post_id IS NULL THEN NULL ELSE post.actor_id END AS sharer_id,
  CASE WHEN post.shared_post_id IS NULL THEN 0 ELSE 1 END AS is_shared,
  post.published
FROM account
JOIN actor ON actor.account_id = account.id
JOIN following ON following.follower_id = actor.id
JOIN post ON post.actor_id = following.followee_id
WHERE post.visibility IN ('public', 'unlisted', 'followers');--> statement-breakpoint

-- 2. Insert user's own posts
INSERT INTO timeline_candidates
SELECT
  account.id AS account_id,
  COALESCE(post.shared_post_id, post.id) AS post_id,
  CASE WHEN post.shared_post_id IS NULL THEN post.actor_id ELSE NULL END AS original_author_id,
  CASE WHEN post.shared_post_id IS NULL THEN NULL ELSE post.actor_id END AS sharer_id,
  CASE WHEN post.shared_post_id IS NULL THEN 0 ELSE 1 END AS is_shared,
  post.published
FROM account
JOIN actor ON actor.account_id = account.id
JOIN post ON post.actor_id = actor.id;--> statement-breakpoint

-- 3. Insert posts that mention the user
INSERT INTO timeline_candidates
SELECT
  account.id AS account_id,
  COALESCE(post.shared_post_id, post.id) AS post_id,
  CASE WHEN post.shared_post_id IS NULL THEN post.actor_id ELSE NULL END AS original_author_id,
  CASE WHEN post.shared_post_id IS NULL THEN NULL ELSE post.actor_id END AS sharer_id,
  CASE WHEN post.shared_post_id IS NULL THEN 0 ELSE 1 END AS is_shared,
  post.published
FROM account
JOIN actor ON actor.account_id = account.id
JOIN mention ON mention.actor_id = actor.id
JOIN post ON post.id = mention.post_id;--> statement-breakpoint

-- 4. Insert posts that quote the user's posts
INSERT INTO timeline_candidates
SELECT
  account.id AS account_id,
  COALESCE(post.shared_post_id, post.id) AS post_id,
  CASE WHEN post.shared_post_id IS NULL THEN post.actor_id ELSE NULL END AS original_author_id,
  CASE WHEN post.shared_post_id IS NULL THEN NULL ELSE post.actor_id END AS sharer_id,
  CASE WHEN post.shared_post_id IS NULL THEN 0 ELSE 1 END AS is_shared,
  post.published
FROM account
JOIN actor ON actor.account_id = account.id
JOIN post AS my_post ON my_post.actor_id = actor.id
JOIN post ON post.quoted_post_id = my_post.id
WHERE post.visibility IN ('public', 'unlisted');--> statement-breakpoint

-- Final aggregation to populate timeline_item
INSERT INTO timeline_item (
  account_id,
  post_id,
  original_author_id,
  last_sharer_id,
  sharers_count,
  added,
  appended
)
SELECT
  account_id,
  post_id,
  -- Get the original author (first non-null value ordered by published date)
  (SELECT original_author_id FROM timeline_candidates tc
   WHERE tc.account_id = t.account_id AND tc.post_id = t.post_id AND tc.original_author_id IS NOT NULL
   ORDER BY tc.published LIMIT 1) AS original_author_id,
  -- Get the most recent sharer
  (SELECT sharer_id FROM timeline_candidates tc
   WHERE tc.account_id = t.account_id AND tc.post_id = t.post_id AND tc.sharer_id IS NOT NULL
   ORDER BY tc.published DESC LIMIT 1) AS last_sharer_id,
  -- Count number of shares
  SUM(is_shared) AS sharers_count,
  -- Earliest post date
  MIN(published) AS added,
  -- Latest post date
  MAX(published) AS appended
FROM timeline_candidates t
GROUP BY account_id, post_id;
