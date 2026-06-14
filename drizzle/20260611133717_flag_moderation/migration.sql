CREATE TYPE "flag_action_type" AS ENUM('dismiss', 'warning', 'censor', 'suspend', 'ban');--> statement-breakpoint
CREATE TYPE "flag_appeal_result" AS ENUM('dismissed', 'reduced', 'withdrawn', 'increased');--> statement-breakpoint
CREATE TYPE "flag_appeal_status" AS ENUM('pending', 'reviewing', 'resolved');--> statement-breakpoint
CREATE TYPE "flag_case_status" AS ENUM('pending', 'reviewing', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "flag_status" AS ENUM('pending', 'reviewing', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "moderation_notification_type" AS ENUM('flag_received', 'action_taken', 'appeal_received', 'appeal_resolved', 'suspension_ending');--> statement-breakpoint
CREATE TABLE "content_snapshot" (
	"id" uuid PRIMARY KEY,
	"flag_id" uuid NOT NULL UNIQUE,
	"post_id" uuid,
	"post_iri" text,
	"content_html" text NOT NULL,
	"source_content" text,
	"metadata" jsonb,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "content_snapshot_post_iri_check" CHECK ("post_id" IS NULL OR "post_iri" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "flag_action" (
	"id" uuid PRIMARY KEY,
	"case_id" uuid NOT NULL,
	"moderator_id" uuid NOT NULL,
	"action_type" "flag_action_type" NOT NULL,
	"violated_provisions" text[] DEFAULT (ARRAY[]::text[])::text[] NOT NULL,
	"rationale" text NOT NULL,
	"message_to_user" text,
	"suspension_starts" timestamp with time zone,
	"suspension_ends" timestamp with time zone,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "flag_action_provisions_check" CHECK (
        "action_type" = 'dismiss' OR
        cardinality("violated_provisions") > 0
      ),
	CONSTRAINT "flag_action_suspension_check" CHECK (
        CASE "action_type"
          WHEN 'suspend' THEN
            "suspension_starts" IS NOT NULL AND
            "suspension_ends" IS NOT NULL AND
            "suspension_ends" > "suspension_starts"
          ELSE
            "suspension_starts" IS NULL AND
            "suspension_ends" IS NULL
        END
      )
);
--> statement-breakpoint
CREATE TABLE "flag_appeal" (
	"id" uuid PRIMARY KEY,
	"action_id" uuid NOT NULL UNIQUE,
	"appellant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"additional_context" text,
	"status" "flag_appeal_status" DEFAULT 'pending'::"flag_appeal_status" NOT NULL,
	"result" "flag_appeal_result",
	"reviewer_id" uuid,
	"review_rationale" text,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"resolved" timestamp with time zone,
	CONSTRAINT "flag_appeal_resolved_check" CHECK (
        CASE "status"
          WHEN 'resolved' THEN
            "result" IS NOT NULL AND "resolved" IS NOT NULL
          ELSE
            "result" IS NULL AND "resolved" IS NULL
        END
      )
);
--> statement-breakpoint
CREATE TABLE "flag_case" (
	"id" uuid PRIMARY KEY,
	"target_actor_id" uuid NOT NULL,
	"target_post_id" uuid,
	"target_post_iri" text,
	"status" "flag_case_status" DEFAULT 'pending'::"flag_case_status" NOT NULL,
	"assigned_moderator_id" uuid,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"resolved" timestamp with time zone,
	CONSTRAINT "flag_case_resolved_check" CHECK (
        ("status" IN ('resolved', 'dismissed')) =
        ("resolved" IS NOT NULL)
      ),
	CONSTRAINT "flag_case_target_post_iri_check" CHECK ("target_post_id" IS NULL OR "target_post_iri" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "flag" (
	"id" uuid PRIMARY KEY,
	"iri" text UNIQUE,
	"reporter_id" uuid NOT NULL,
	"target_actor_id" uuid NOT NULL,
	"target_post_id" uuid,
	"target_post_iri" text,
	"reason" text NOT NULL,
	"coc_version" text,
	"llm_analysis" jsonb,
	"status" "flag_status" DEFAULT 'pending'::"flag_status" NOT NULL,
	"case_id" uuid NOT NULL,
	"forward_to_remote" boolean DEFAULT false NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "flag_target_post_iri_check" CHECK ("target_post_id" IS NULL OR "target_post_iri" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "moderation_notification" (
	"id" uuid PRIMARY KEY,
	"account_id" uuid NOT NULL,
	"type" "moderation_notification_type" NOT NULL,
	"case_id" uuid,
	"action_id" uuid,
	"appeal_id" uuid,
	"read" timestamp with time zone,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "moderation_notification_ref_check" CHECK (
        CASE "type"
          WHEN 'flag_received' THEN
            "case_id" IS NOT NULL AND
            "action_id" IS NULL AND
            "appeal_id" IS NULL
          WHEN 'action_taken' THEN
            "action_id" IS NOT NULL AND
            "case_id" IS NULL AND
            "appeal_id" IS NULL
          WHEN 'suspension_ending' THEN
            "action_id" IS NOT NULL AND
            "case_id" IS NULL AND
            "appeal_id" IS NULL
          ELSE
            "appeal_id" IS NOT NULL AND
            "case_id" IS NULL AND
            "action_id" IS NULL
        END
      )
);
--> statement-breakpoint
ALTER TABLE "actor" ADD COLUMN "suspended" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "actor" ADD COLUMN "suspended_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "censored" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "flag_action_case_id_index" ON "flag_action" ("case_id");--> statement-breakpoint
CREATE INDEX "flag_appeal_appellant_id_index" ON "flag_appeal" ("appellant_id");--> statement-breakpoint
CREATE INDEX "flag_case_target_actor_id_index" ON "flag_case" ("target_actor_id");--> statement-breakpoint
CREATE INDEX "flag_case_status_created_idx" ON "flag_case" ("status","created" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "flag_case_open_post_target_idx" ON "flag_case" ("target_actor_id","target_post_iri") WHERE 
        "status" IN ('pending', 'reviewing')
        AND "target_post_iri" IS NOT NULL
      ;--> statement-breakpoint
CREATE UNIQUE INDEX "flag_case_open_actor_target_idx" ON "flag_case" ("target_actor_id") WHERE 
        "status" IN ('pending', 'reviewing')
        AND "target_post_iri" IS NULL
      ;--> statement-breakpoint
CREATE INDEX "flag_case_id_index" ON "flag" ("case_id");--> statement-breakpoint
CREATE INDEX "flag_reporter_id_created_idx" ON "flag" ("reporter_id","created" desc);--> statement-breakpoint
CREATE INDEX "flag_target_actor_id_index" ON "flag" ("target_actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flag_open_reporter_case_idx" ON "flag" ("case_id","reporter_id") WHERE "status" IN ('pending', 'reviewing');--> statement-breakpoint
CREATE INDEX "moderation_notification_account_created_idx" ON "moderation_notification" ("account_id","created" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_notification_suspension_ending_idx" ON "moderation_notification" ("account_id","action_id") WHERE "type" = 'suspension_ending';--> statement-breakpoint
ALTER TABLE "content_snapshot" ADD CONSTRAINT "content_snapshot_flag_id_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "flag"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "content_snapshot" ADD CONSTRAINT "content_snapshot_post_id_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "flag_action" ADD CONSTRAINT "flag_action_case_id_flag_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "flag_case"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "flag_action" ADD CONSTRAINT "flag_action_moderator_id_account_id_fkey" FOREIGN KEY ("moderator_id") REFERENCES "account"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "flag_appeal" ADD CONSTRAINT "flag_appeal_action_id_flag_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "flag_action"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "flag_appeal" ADD CONSTRAINT "flag_appeal_appellant_id_account_id_fkey" FOREIGN KEY ("appellant_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "flag_appeal" ADD CONSTRAINT "flag_appeal_reviewer_id_account_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "flag_case" ADD CONSTRAINT "flag_case_target_actor_id_actor_id_fkey" FOREIGN KEY ("target_actor_id") REFERENCES "actor"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "flag_case" ADD CONSTRAINT "flag_case_target_post_id_post_id_fkey" FOREIGN KEY ("target_post_id") REFERENCES "post"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "flag_case" ADD CONSTRAINT "flag_case_assigned_moderator_id_account_id_fkey" FOREIGN KEY ("assigned_moderator_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "flag" ADD CONSTRAINT "flag_reporter_id_actor_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "actor"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "flag" ADD CONSTRAINT "flag_target_actor_id_actor_id_fkey" FOREIGN KEY ("target_actor_id") REFERENCES "actor"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "flag" ADD CONSTRAINT "flag_target_post_id_post_id_fkey" FOREIGN KEY ("target_post_id") REFERENCES "post"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "flag" ADD CONSTRAINT "flag_case_id_flag_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "flag_case"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "moderation_notification" ADD CONSTRAINT "moderation_notification_account_id_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "moderation_notification" ADD CONSTRAINT "moderation_notification_case_id_flag_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "flag_case"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "moderation_notification" ADD CONSTRAINT "moderation_notification_action_id_flag_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "flag_action"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "moderation_notification" ADD CONSTRAINT "moderation_notification_appeal_id_flag_appeal_id_fkey" FOREIGN KEY ("appeal_id") REFERENCES "flag_appeal"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actor" ADD CONSTRAINT "actor_suspended_check" CHECK (
        "suspended_until" IS NULL OR (
          "suspended" IS NOT NULL AND
          "suspended_until" > "suspended"
        )
      );