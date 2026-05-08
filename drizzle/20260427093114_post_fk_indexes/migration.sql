CREATE INDEX "notification_post_id_index" ON "notification" USING btree ("post_id") WHERE "notification"."post_id" is not null;--> statement-breakpoint
CREATE INDEX "post_shared_post_id_index" ON "post" USING btree ("shared_post_id") WHERE "post"."shared_post_id" is not null;--> statement-breakpoint
CREATE INDEX "post_quoted_post_id_index" ON "post" USING btree ("quoted_post_id") WHERE "post"."quoted_post_id" is not null;--> statement-breakpoint
CREATE INDEX "timeline_item_post_id_index" ON "timeline_item" USING btree ("post_id");