CREATE INDEX "idx_timeline_item_account_id_appended" ON "timeline_item" USING btree ("account_id","appended" desc);
