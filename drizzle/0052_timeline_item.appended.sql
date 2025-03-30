ALTER TABLE "timeline_item" ADD COLUMN "appended" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
DELETE FROM timeline_item;--> statement-breakpoint
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
  account.id account_id,
  coalesce(post.shared_post_id, post.id) post_id,
  any_value(
    CASE
      WHEN post.shared_post_id IS NULL THEN post.actor_id
      ELSE NULL
    END
    ORDER BY post.published
  ) original_author_id,
  any_value(
    CASE
      WHEN post.shared_post_id IS NULL THEN NULL
      ELSE post.actor_id
    END
    ORDER BY post.published DESC
  ) last_sharer_id,
  sum(
    CASE
      WHEN post.shared_post_id IS NULL THEN 0
      ELSE 1
    END
  ) sharers_count,
  min(post.published) added,
  max(post.published) appended
FROM account
JOIN actor ON actor.account_id = account.id
JOIN following ON following.follower_id = actor.id
JOIN mention ON mention.actor_id = actor.id
JOIN post AS quoted_post ON quoted_post.actor_id = actor.id
JOIN post
  ON post.actor_id = following.followee_id
  OR post.actor_id = actor.id
  OR post.id = mention.post_id
  OR post.quoted_post_id = quoted_post.id
GROUP BY account.id, coalesce(post.shared_post_id, post.id)
