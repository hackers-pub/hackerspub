CREATE TABLE IF NOT EXISTS "note_source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"content" text NOT NULL,
	"language" varchar NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"published" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "note_source_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "note_source" ADD CONSTRAINT "note_source_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post" ADD CONSTRAINT "post_note_source_id_note_source_id_fk" FOREIGN KEY ("note_source_id") REFERENCES "public"."note_source"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_note_source_id_unique" UNIQUE("note_source_id");--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_note_source_id_check" CHECK ("post"."type" = 'Note' OR "post"."type" = 'Question' OR "post"."note_source_id" IS NULL);