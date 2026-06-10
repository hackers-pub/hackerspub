ALTER TABLE "post" DROP CONSTRAINT "post_note_source_id_check";--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_note_source_id_check" CHECK ("post"."type" IN ('Note', 'Question') OR "post"."note_source_id" IS NULL);
