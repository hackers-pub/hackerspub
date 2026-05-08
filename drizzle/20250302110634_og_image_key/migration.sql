ALTER TABLE "account" ADD COLUMN "og_image_key" text;--> statement-breakpoint
ALTER TABLE "article_source" ADD COLUMN "og_image_key" text;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_og_image_key_unique" UNIQUE("og_image_key");--> statement-breakpoint
ALTER TABLE "article_source" ADD CONSTRAINT "article_source_og_image_key_unique" UNIQUE("og_image_key");