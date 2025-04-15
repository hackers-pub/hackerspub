ALTER TYPE "public"."post_medium_type" ADD VALUE 'video/mp4';--> statement-breakpoint
ALTER TYPE "public"."post_medium_type" ADD VALUE 'video/webm';--> statement-breakpoint
ALTER TABLE "post_medium" ADD COLUMN "thumbnail_key" text;--> statement-breakpoint
ALTER TABLE "post_medium" ADD CONSTRAINT "post_medium_thumbnail_key_unique" UNIQUE("thumbnail_key");