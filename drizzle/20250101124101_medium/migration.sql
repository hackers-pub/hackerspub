CREATE TYPE "public"."medium_type" AS ENUM('image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "medium" (
	"post_id" uuid NOT NULL,
	"index" smallint NOT NULL,
	"type" "medium_type" NOT NULL,
	"url" text NOT NULL,
	"alt" text,
	"width" integer,
	"height" integer,
	"sensitive" boolean DEFAULT false NOT NULL,
	CONSTRAINT "medium_post_id_index_pk" PRIMARY KEY("post_id","index"),
	CONSTRAINT "medium_index_check" CHECK ("medium"."index" >= 0),
	CONSTRAINT "medium_url_check" CHECK ("medium"."url" ~ '^https?://'),
	CONSTRAINT "medium_width_height_check" CHECK (
        CASE
          WHEN "medium"."width" IS NULL THEN "medium"."height" IS NULL
          ELSE "medium"."height" IS NOT NULL AND
               "medium"."width" > 0 AND "medium"."height" > 0
        END
      )
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "medium" ADD CONSTRAINT "medium_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
