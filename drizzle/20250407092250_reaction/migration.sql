CREATE TABLE "custom_emoji" (
	"id" uuid PRIMARY KEY NOT NULL,
	"iri" text NOT NULL,
	"name" text NOT NULL,
	"image_type" text,
	"image_url" text NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "custom_emoji_iri_unique" UNIQUE("iri"),
	CONSTRAINT "custom_emoji_name_check" CHECK ("custom_emoji"."name" ~ '^:[^:[:space:]]+:$'),
	CONSTRAINT "custom_emoji_image_type_check" CHECK (
        CASE
          WHEN "custom_emoji"."image_type" IS NULL THEN true
          ELSE "custom_emoji"."image_type" ~ '^image/'
        END
      ),
	CONSTRAINT "custom_emoji_image_url_check" CHECK ("custom_emoji"."image_url" ~ '^https?://')
);
--> statement-breakpoint
CREATE TABLE "reaction" (
	"iri" text PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"emoji" text,
	"custom_emoji_id" uuid,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "reaction_emoji_check" CHECK (
        "reaction"."emoji" IS NOT NULL
          AND length("reaction"."emoji") > 0
          AND "reaction"."emoji" !~ '^[[:space:]:]+|[[:space:]:]+$'
          AND "reaction"."custom_emoji_id" IS NULL
        OR
          "reaction"."emoji" IS NULL AND "reaction"."custom_emoji_id" IS NOT NULL
      )
);
--> statement-breakpoint
ALTER TABLE "post" RENAME COLUMN "reactionsCount" TO "reactions_counts";--> statement-breakpoint
ALTER TABLE "actor" DROP CONSTRAINT "actor_successor_id_actor_id_fk";
--> statement-breakpoint
ALTER TABLE "reaction" ADD CONSTRAINT "reaction_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction" ADD CONSTRAINT "reaction_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction" ADD CONSTRAINT "reaction_custom_emoji_id_custom_emoji_id_fk" FOREIGN KEY ("custom_emoji_id") REFERENCES "public"."custom_emoji"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reaction_post_id_actor_id_emoji_index" ON "reaction" USING btree ("post_id","actor_id","emoji") WHERE "reaction"."custom_emoji_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reaction_post_id_actor_id_custom_emoji_id_index" ON "reaction" USING btree ("post_id","actor_id","custom_emoji_id") WHERE "reaction"."emoji" is null;--> statement-breakpoint
CREATE INDEX "reaction_post_id_index" ON "reaction" USING btree ("post_id");--> statement-breakpoint
ALTER TABLE "actor" ADD CONSTRAINT "actor_successor_id_actor_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."actor"("id") ON DELETE set null ON UPDATE no action;