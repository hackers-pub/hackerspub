DROP INDEX "idx_timeline_item_account_id_added";--> statement-breakpoint
CREATE INDEX "idx_timeline_item_account_id_added" ON "timeline_item" ("account_id",("added"::timestamptz(3)) desc,"post_id" desc);--> statement-breakpoint
DROP INDEX "idx_timeline_item_account_id_appended";--> statement-breakpoint
CREATE INDEX "idx_timeline_item_account_id_appended" ON "timeline_item" ("account_id",("appended"::timestamptz(3)) desc,"post_id" desc);