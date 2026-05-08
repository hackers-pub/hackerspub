CREATE TABLE IF NOT EXISTS "post_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"type" text,
	"description" text,
	"image_url" text,
	"image_type" text,
	"image_width" integer,
	"image_height" integer,
	"creator_id" uuid,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"scraped" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "post_link_url_unique" UNIQUE("url"),
	CONSTRAINT "post_link_image_type_check" CHECK (
        CASE
          WHEN "post_link"."image_type" IS NULL THEN true
          ELSE "post_link"."image_type" ~ '^image/' AND
               "post_link"."image_url" IS NOT NULL
        END
      ),
	CONSTRAINT "post_link_image_width_height_check" CHECK (
        CASE
          WHEN "post_link"."image_width" IS NOT NULL
          THEN "post_link"."image_url" IS NOT NULL AND
                 "post_link"."image_height" IS NOT NULL AND
                 "post_link"."image_width" > 0 AND
                 "post_link"."image_height" > 0
          WHEN "post_link"."image_height" IS NOT NULL
          THEN "post_link"."image_url" IS NOT NULL AND
               "post_link"."image_width" IS NOT NULL AND
               "post_link"."image_width" > 0 AND
               "post_link"."image_height" > 0
          ELSE true
        END
      )
);
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "link_id" uuid;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "link_url" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post_link" ADD CONSTRAINT "post_link_creator_id_actor_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."actor"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post" ADD CONSTRAINT "post_link_id_post_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."post_link"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_link_id_check" CHECK (("post"."link_id" IS NULL) = ("post"."link_url" IS NULL));