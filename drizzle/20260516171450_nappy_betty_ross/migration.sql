CREATE TYPE "quote_policy" AS ENUM('everyone', 'followers', 'self');--> statement-breakpoint
ALTER TABLE "article_source" ADD COLUMN "quote_policy" "quote_policy" DEFAULT 'everyone'::"quote_policy" NOT NULL;--> statement-breakpoint
ALTER TABLE "note_source" ADD COLUMN "quote_policy" "quote_policy" DEFAULT 'everyone'::"quote_policy" NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "quote_policy" "quote_policy" DEFAULT 'everyone'::"quote_policy" NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "quote_authorization_iri" text;--> statement-breakpoint
UPDATE "note_source"
SET "quote_policy" = 'self'::"quote_policy"
WHERE "visibility" NOT IN ('public', 'unlisted');--> statement-breakpoint
UPDATE "post"
SET "quote_policy" = 'self'::"quote_policy"
WHERE "visibility" NOT IN ('public', 'unlisted');
