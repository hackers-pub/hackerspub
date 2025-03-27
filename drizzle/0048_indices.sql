CREATE INDEX "following_follower_id_index" ON "following" USING btree ("follower_id");--> statement-breakpoint
CREATE INDEX "mention_actor_id_index" ON "mention" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "post_link_creator_id_index" ON "post_link" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "idx_post_visibility_published" ON "post" USING btree ("visibility","published" desc);--> statement-breakpoint
CREATE INDEX "idx_post_actor_id_published" ON "post" USING btree ("actor_id","published" desc);--> statement-breakpoint
CREATE INDEX "post_reply_target_id_index" ON "post" USING btree ("reply_target_id");