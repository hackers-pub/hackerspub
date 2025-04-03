DROP INDEX "idx_notification_account_id_id";--> statement-breakpoint
CREATE INDEX "idx_notification_account_id_created" ON "notification" USING btree ("account_id","created" desc);