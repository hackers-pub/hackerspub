ALTER TABLE "article_content" DROP CONSTRAINT "article_content_original_language_check";
--> statement-breakpoint
ALTER TABLE "article_content" ADD CONSTRAINT "article_content_original_language_check" CHECK (
  "original_language" IS NOT NULL OR (
    "translator_id" IS NULL AND
    "translation_requester_id" IS NULL
  )
);
--> statement-breakpoint
ALTER TABLE "deleted_account_key" DROP CONSTRAINT "deleted_account_key_public_check";
--> statement-breakpoint
ALTER TABLE "deleted_account_key" ADD CONSTRAINT "deleted_account_key_public_check" CHECK (jsonb_typeof("public") = 'object');
--> statement-breakpoint
ALTER TABLE "deleted_account_key" DROP CONSTRAINT "deleted_account_key_private_check";
--> statement-breakpoint
ALTER TABLE "deleted_account_key" ADD CONSTRAINT "deleted_account_key_private_check" CHECK (jsonb_typeof("private") = 'object');
