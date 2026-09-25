-- Repair cached counts that drifted below zero before the checks below are
-- added (https://github.com/hackers-pub/hackerspub/issues/394).  The number
-- of accepted followings we know about is a lower bound of the real count.
UPDATE "actor"
SET "followees_count" = (
  SELECT count(*)
  FROM "following"
  WHERE "following"."follower_id" = "actor"."id"
    AND "following"."accepted" IS NOT NULL
)
WHERE "followees_count" < 0;--> statement-breakpoint
UPDATE "actor"
SET "followers_count" = (
  SELECT count(*)
  FROM "following"
  WHERE "following"."followee_id" = "actor"."id"
    AND "following"."accepted" IS NOT NULL
)
WHERE "followers_count" < 0;--> statement-breakpoint
UPDATE "actor" SET "posts_count" = 0 WHERE "posts_count" < 0;--> statement-breakpoint
ALTER TABLE "actor" ADD CONSTRAINT "actor_followees_count_check" CHECK ("followees_count" >= 0);--> statement-breakpoint
ALTER TABLE "actor" ADD CONSTRAINT "actor_followers_count_check" CHECK ("followers_count" >= 0);--> statement-breakpoint
ALTER TABLE "actor" ADD CONSTRAINT "actor_posts_count_check" CHECK ("posts_count" >= 0);
