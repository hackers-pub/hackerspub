DELETE FROM "post" WHERE "post"."id" NOT IN (
  SELECT any_value("post"."id")
  FROM "post"
  WHERE "post"."shared_post_id" IS NOT NULL
  GROUP BY "post"."actor_id", "post"."shared_post_id"
) AND "post"."shared_post_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_actor_id_shared_post_id_unique" UNIQUE("actor_id","shared_post_id");
