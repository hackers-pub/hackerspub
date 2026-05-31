ALTER TABLE "post_link" ADD COLUMN "score" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_link" ADD COLUMN "weighted_mass" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_link" ADD COLUMN "recency_component" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_link" ADD COLUMN "post_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_link" ADD COLUMN "first_shared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_link" ADD COLUMN "latest_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_link" ADD COLUMN "score_updated" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_post_link_score" ON "post_link" ("score" desc,"id" desc) WHERE ("latest_activity_at" is not null);--> statement-breakpoint
CREATE INDEX "idx_post_link_first_shared" ON "post_link" ("first_shared_at" desc,"id" desc) WHERE ("latest_activity_at" is not null);--> statement-breakpoint
CREATE INDEX "idx_post_link_weighted_mass" ON "post_link" ("weighted_mass" desc,"id" desc) WHERE ("latest_activity_at" is not null);