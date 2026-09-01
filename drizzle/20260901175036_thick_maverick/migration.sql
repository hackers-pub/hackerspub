ALTER TABLE "quote_request" ADD COLUMN "object_updated" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "quote_request" SET "object_updated" = false;--> statement-breakpoint
ALTER TABLE "quote_request" ADD COLUMN "superseded" timestamp with time zone;
