ALTER TABLE "news_rescore_queue" RENAME COLUMN "claimed_at" TO "claimed";--> statement-breakpoint
ALTER TABLE "organization_notification_read" RENAME COLUMN "read_at" TO "read";--> statement-breakpoint
ALTER TABLE "post_link" RENAME COLUMN "first_shared_at" TO "first_shared";--> statement-breakpoint
ALTER TABLE "post_link" RENAME COLUMN "latest_activity_at" TO "latest_activity";--> statement-breakpoint
UPDATE "flag"
SET "llm_analysis" = jsonb_set(
	"llm_analysis" - 'analyzedAt',
	'{analyzed}',
	COALESCE("llm_analysis" -> 'analyzed', "llm_analysis" -> 'analyzedAt')
)
WHERE "llm_analysis" ? 'analyzedAt';--> statement-breakpoint
DROP INDEX "idx_post_link_score";--> statement-breakpoint
CREATE INDEX "idx_post_link_score" ON "post_link" ("score" desc,"id" desc) WHERE ("latest_activity" is not null);--> statement-breakpoint
DROP INDEX "idx_post_link_first_shared";--> statement-breakpoint
CREATE INDEX "idx_post_link_first_shared" ON "post_link" ("first_shared" desc,"id" desc) WHERE ("latest_activity" is not null);--> statement-breakpoint
DROP INDEX "idx_post_link_weighted_mass";--> statement-breakpoint
CREATE INDEX "idx_post_link_weighted_mass" ON "post_link" ("weighted_mass" desc,"id" desc) WHERE ("latest_activity" is not null);
