ALTER TABLE "timeline_item" ADD COLUMN "original_author_id" uuid;--> statement-breakpoint
ALTER TABLE "timeline_item" ADD CONSTRAINT "timeline_item_original_author_id_actor_id_fk" FOREIGN KEY ("original_author_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;
