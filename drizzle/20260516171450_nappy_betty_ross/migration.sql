CREATE TYPE "quote_policy" AS ENUM('everyone', 'followers', 'self');--> statement-breakpoint
ALTER TABLE "article_source" ADD COLUMN "quote_policy" "quote_policy" DEFAULT 'everyone'::"quote_policy" NOT NULL;--> statement-breakpoint
ALTER TABLE "note_source" ADD COLUMN "quote_policy" "quote_policy" DEFAULT 'everyone'::"quote_policy" NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "quote_policy" "quote_policy" DEFAULT 'everyone'::"quote_policy" NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "quote_authorization_iri" text;--> statement-breakpoint
CREATE INDEX "post_quote_authorization_iri_index" ON "post" ("quote_authorization_iri") WHERE "quote_authorization_iri" IS NOT NULL;--> statement-breakpoint
UPDATE "note_source"
SET "quote_policy" = 'self'::"quote_policy"
WHERE "visibility" NOT IN ('public', 'unlisted');--> statement-breakpoint
UPDATE "post"
SET "quote_policy" = 'self'::"quote_policy"
WHERE "visibility" NOT IN ('public', 'unlisted');
