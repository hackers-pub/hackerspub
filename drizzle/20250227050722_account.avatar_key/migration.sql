ALTER TABLE "account" ADD COLUMN "avatar_key" text;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_avatar_key_unique" UNIQUE("avatar_key");