CREATE TABLE IF NOT EXISTS "note_medium" (
	"note_source_id" uuid NOT NULL,
	"index" smallint NOT NULL,
	"key" text NOT NULL,
	"alt" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	CONSTRAINT "note_medium_note_source_id_index_pk" PRIMARY KEY("note_source_id","index"),
	CONSTRAINT "note_medium_key_unique" UNIQUE("key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "note_medium" ADD CONSTRAINT "note_medium_note_source_id_note_source_id_fk" FOREIGN KEY ("note_source_id") REFERENCES "public"."note_source"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
