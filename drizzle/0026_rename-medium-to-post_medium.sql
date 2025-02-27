ALTER TABLE "medium" RENAME TO "post_medium";--> statement-breakpoint
ALTER TABLE "post_medium" DROP CONSTRAINT "medium_index_check";--> statement-breakpoint
ALTER TABLE "post_medium" DROP CONSTRAINT "medium_url_check";--> statement-breakpoint
ALTER TABLE "post_medium" DROP CONSTRAINT "medium_width_height_check";--> statement-breakpoint
ALTER TABLE "post_medium" DROP CONSTRAINT "medium_post_id_post_id_fk";
--> statement-breakpoint
ALTER TABLE "post_medium" DROP CONSTRAINT "medium_post_id_index_pk";--> statement-breakpoint
ALTER TABLE "post_medium" ADD CONSTRAINT "post_medium_post_id_index_pk" PRIMARY KEY("post_id","index");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post_medium" ADD CONSTRAINT "post_medium_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "post_medium" ADD CONSTRAINT "post_medium_index_check" CHECK ("post_medium"."index" >= 0);--> statement-breakpoint
ALTER TABLE "post_medium" ADD CONSTRAINT "post_medium_url_check" CHECK ("post_medium"."url" ~ '^https?://');--> statement-breakpoint
ALTER TABLE "post_medium" ADD CONSTRAINT "post_medium_width_height_check" CHECK (
        CASE
          WHEN "post_medium"."width" IS NULL THEN "post_medium"."height" IS NULL
          ELSE "post_medium"."height" IS NOT NULL AND
               "post_medium"."width" > 0 AND "post_medium"."height" > 0
        END
      );