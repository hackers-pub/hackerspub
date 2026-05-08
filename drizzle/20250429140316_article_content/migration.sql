CREATE TABLE "article_content" (
	"source_id" uuid NOT NULL,
	"language" varchar NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"og_image_key" text,
	"original_language" varchar,
	"translator_id" uuid,
	"translation_requester_id" uuid,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"published" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "article_content_source_id_language_pk" PRIMARY KEY("source_id","language"),
	CONSTRAINT "article_content_og_image_key_unique" UNIQUE("og_image_key"),
	CONSTRAINT "article_content_translator_translation_requester_id_check" CHECK ("article_content"."translator_id" IS NULL OR "article_content"."translation_requester_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "article_source" DROP CONSTRAINT "article_source_og_image_key_unique";--> statement-breakpoint
ALTER TABLE "article_content" ADD CONSTRAINT "article_content_source_id_article_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."article_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_content" ADD CONSTRAINT "article_content_translator_id_account_id_fk" FOREIGN KEY ("translator_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_content" ADD CONSTRAINT "article_content_translation_requester_id_account_id_fk" FOREIGN KEY ("translation_requester_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_content" ADD CONSTRAINT "article_content_source_id_original_language_article_content_source_id_language_fk" FOREIGN KEY ("source_id","original_language") REFERENCES "public"."article_content"("source_id","language") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "article_content"
  (
    "source_id",
    "language",
    "title",
    "content",
    "og_image_key"
  )
  SELECT "id", "language", "title", "content", "og_image_key"
  FROM "article_source";--> statement-breakpoint
ALTER TABLE "article_source" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "article_source" DROP COLUMN "content";--> statement-breakpoint
ALTER TABLE "article_source" DROP COLUMN "language";--> statement-breakpoint
ALTER TABLE "article_source" DROP COLUMN "og_image_key";
