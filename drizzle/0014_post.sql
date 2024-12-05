CREATE TYPE "public"."post_type" AS ENUM('Article', 'Note', 'Question');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "post" (
	"id" uuid PRIMARY KEY NOT NULL,
	"iri" text NOT NULL,
	"type" "post_type" NOT NULL,
	"actor_id" uuid NOT NULL,
	"article_source_id" uuid,
	"shared_post_id" uuid,
	"reply_target_id" uuid,
	"summary" text,
	"content_html" text NOT NULL,
	"language" varchar,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emojis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"replies_count" integer DEFAULT 0 NOT NULL,
	"likes_count" integer DEFAULT 0 NOT NULL,
	"shares_count" integer DEFAULT 0 NOT NULL,
	"reactionsCount" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"url" text,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"published" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "post_iri_unique" UNIQUE("iri"),
	CONSTRAINT "post_article_source_id_unique" UNIQUE("article_source_id"),
	CONSTRAINT "post_article_source_id_check" CHECK (
        CASE "post"."type"
          WHEN 'Article' THEN "post"."article_source_id" IS NOT NULL
          ELSE "post"."article_source_id" IS NULL
        END
      ),
	CONSTRAINT "post_shared_post_id_reply_target_id_check" CHECK ("post"."shared_post_id" IS NULL OR "post"."reply_target_id" IS NULL)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post" ADD CONSTRAINT "post_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post" ADD CONSTRAINT "post_article_source_id_article_source_id_fk" FOREIGN KEY ("article_source_id") REFERENCES "public"."article_source"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post" ADD CONSTRAINT "post_shared_post_id_post_id_fk" FOREIGN KEY ("shared_post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post" ADD CONSTRAINT "post_reply_target_id_post_id_fk" FOREIGN KEY ("reply_target_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
