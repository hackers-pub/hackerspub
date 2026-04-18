DROP INDEX "idx_bookmark_account_created";--> statement-breakpoint
CREATE INDEX "idx_bookmark_account_created" ON "bookmark" USING btree ("account_id","created" desc,"post_id" desc);