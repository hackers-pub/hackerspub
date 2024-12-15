CREATE TYPE "public"."post_visibility" AS ENUM('public', 'unlisted', 'followers', 'direct', 'none');--> statement-breakpoint
ALTER TABLE "note_source" ADD COLUMN "visibility" "post_visibility" DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "visibility" "post_visibility" DEFAULT 'unlisted' NOT NULL;