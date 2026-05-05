DO $$ BEGIN
 CREATE TYPE "public"."medium_type" AS ENUM(
   'image/gif',
   'image/jpeg',
   'image/png',
   'image/webp'
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "medium" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "type" "medium_type" NOT NULL,
  "content_hash" text,
  "width" integer,
  "height" integer,
  "created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "medium_key_unique" UNIQUE("key"),
  CONSTRAINT "medium_content_hash_unique" UNIQUE("content_hash"),
  CONSTRAINT "medium_width_height_check" CHECK (
    CASE
      WHEN "width" IS NULL THEN "height" IS NULL
      ELSE "height" IS NOT NULL AND "width" > 0 AND "height" > 0
    END
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "note_source_medium" (
  "note_source_id" uuid NOT NULL,
  "index" smallint NOT NULL,
  "medium_id" uuid NOT NULL,
  "alt" text NOT NULL,
  CONSTRAINT "note_source_medium_note_source_id_index_pk"
    PRIMARY KEY("note_source_id","index"),
  CONSTRAINT "note_source_medium_note_source_id_medium_id_unique"
    UNIQUE("note_source_id","medium_id"),
  CONSTRAINT "note_source_medium_index_check" CHECK ("index" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "article_draft_medium" (
  "article_draft_id" uuid NOT NULL,
  "key" text NOT NULL,
  "medium_id" uuid NOT NULL,
  "created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "article_draft_medium_article_draft_id_key_pk"
    PRIMARY KEY("article_draft_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "article_source_medium" (
  "article_source_id" uuid NOT NULL,
  "key" text NOT NULL,
  "medium_id" uuid NOT NULL,
  "created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "article_source_medium_article_source_id_key_pk"
    PRIMARY KEY("article_source_id","key")
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "avatar_medium_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account" ADD CONSTRAINT "account_avatar_medium_id_medium_id_fk"
   FOREIGN KEY ("avatar_medium_id") REFERENCES "public"."medium"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "note_source_medium" ADD CONSTRAINT
   "note_source_medium_note_source_id_note_source_id_fk"
   FOREIGN KEY ("note_source_id") REFERENCES "public"."note_source"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "note_source_medium" ADD CONSTRAINT
   "note_source_medium_medium_id_medium_id_fk"
   FOREIGN KEY ("medium_id") REFERENCES "public"."medium"("id")
   ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_draft_medium" ADD CONSTRAINT
   "article_draft_medium_article_draft_id_article_draft_id_fk"
   FOREIGN KEY ("article_draft_id") REFERENCES "public"."article_draft"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_draft_medium" ADD CONSTRAINT
   "article_draft_medium_medium_id_medium_id_fk"
   FOREIGN KEY ("medium_id") REFERENCES "public"."medium"("id")
   ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_source_medium" ADD CONSTRAINT
   "article_source_medium_article_source_id_article_source_id_fk"
   FOREIGN KEY ("article_source_id") REFERENCES "public"."article_source"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_source_medium" ADD CONSTRAINT
   "article_source_medium_medium_id_medium_id_fk"
   FOREIGN KEY ("medium_id") REFERENCES "public"."medium"("id")
   ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
INSERT INTO "medium" ("key", "type", "content_hash", "width", "height")
SELECT DISTINCT ON ("key")
  "key",
  'image/webp'::"medium_type",
  NULL::text,
  "width"::integer,
  "height"::integer
FROM "note_medium"
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "medium" ("key", "type", "content_hash", "width", "height", "created")
SELECT DISTINCT ON ("key")
  "key",
  'image/webp'::"medium_type",
  CASE
    WHEN "key" ~ '^media/[0-9a-f]{64}\.webp$' THEN substring("key" from 7 for 64)
    ELSE NULL::text
  END,
  "width"::integer,
  "height"::integer,
  "created"
FROM "article_medium"
ON CONFLICT ("key") DO UPDATE SET
  "content_hash" = COALESCE("medium"."content_hash", EXCLUDED."content_hash"),
  "width" = COALESCE("medium"."width", EXCLUDED."width"::integer),
  "height" = COALESCE("medium"."height", EXCLUDED."height"::integer);
--> statement-breakpoint
INSERT INTO "medium" ("key", "type", "content_hash", "width", "height")
SELECT DISTINCT
  "avatar_key",
  CASE
    WHEN lower("avatar_key") LIKE '%.gif' THEN 'image/gif'::"medium_type"
    WHEN lower("avatar_key") LIKE '%.png' THEN 'image/png'::"medium_type"
    WHEN lower("avatar_key") LIKE '%.webp' THEN 'image/webp'::"medium_type"
    ELSE 'image/jpeg'::"medium_type"
  END,
  NULL::text,
  NULL::integer,
  NULL::integer
FROM "account"
WHERE "avatar_key" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "note_source_medium" (
  "note_source_id",
  "index",
  "medium_id",
  "alt"
)
SELECT nm."note_source_id", nm."index", m."id", nm."alt"
FROM "note_medium" nm
JOIN "medium" m ON m."key" = nm."key"
ON CONFLICT ("note_source_id", "index") DO NOTHING;
--> statement-breakpoint
INSERT INTO "article_draft_medium" ("article_draft_id", "key", "medium_id", "created")
SELECT am."article_draft_id", am."key", m."id", am."created"
FROM "article_medium" am
JOIN "medium" m ON m."key" = am."key"
WHERE am."article_draft_id" IS NOT NULL
ON CONFLICT ("article_draft_id", "key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "article_source_medium" ("article_source_id", "key", "medium_id", "created")
SELECT am."article_source_id", am."key", m."id", am."created"
FROM "article_medium" am
JOIN "medium" m ON m."key" = am."key"
WHERE am."article_source_id" IS NOT NULL
ON CONFLICT ("article_source_id", "key") DO NOTHING;
--> statement-breakpoint
UPDATE "account" a
SET "avatar_medium_id" = m."id"
FROM "medium" m
WHERE a."avatar_key" = m."key";
--> statement-breakpoint
UPDATE "article_draft" ad
SET "content" = replace(ad."content", am."url", 'hp-medium:' || am."key")
FROM "article_medium" am
WHERE am."article_draft_id" = ad."id";
--> statement-breakpoint
UPDATE "article_content" ac
SET "content" = replace(ac."content", am."url", 'hp-medium:' || am."key")
FROM "article_source" src
JOIN "article_medium" am ON am."article_source_id" = src."id"
WHERE ac."source_id" = src."id";
--> statement-breakpoint
DROP TABLE "note_medium";
--> statement-breakpoint
DROP TABLE "article_medium";
--> statement-breakpoint
ALTER TABLE "account" DROP CONSTRAINT IF EXISTS "account_avatar_key_unique";
--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "avatar_key";
