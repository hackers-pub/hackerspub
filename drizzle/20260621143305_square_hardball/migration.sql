CREATE TYPE "account_kind" AS ENUM('personal', 'organization');--> statement-breakpoint
CREATE TYPE "organization_member_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "post_attribution_mode" AS ENUM('acting_account_only', 'acting_account_with_viewer');--> statement-breakpoint
CREATE TABLE "organization_conversion_request" (
	"id" uuid PRIMARY KEY,
	"account_id" uuid NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"accepted" timestamp with time zone,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "organization_conversion_request_self_check" CHECK ("account_id" <> "admin_account_id")
);
--> statement-breakpoint
CREATE TABLE "organization_membership" (
	"organization_account_id" uuid,
	"member_account_id" uuid,
	"role" "organization_member_role" DEFAULT 'member'::"organization_member_role" NOT NULL,
	"invited_by_id" uuid,
	"accepted" timestamp with time zone,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "organization_membership_pkey" PRIMARY KEY("organization_account_id","member_account_id"),
	CONSTRAINT "organization_membership_self_check" CHECK ("organization_account_id" <> "member_account_id")
);
--> statement-breakpoint
CREATE TABLE "organization_notification_read" (
	"organization_account_id" uuid,
	"member_account_id" uuid,
	"read_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "organization_notification_read_pkey" PRIMARY KEY("organization_account_id","member_account_id"),
	CONSTRAINT "organization_notification_read_self_check" CHECK ("organization_account_id" <> "member_account_id")
);
--> statement-breakpoint
CREATE TABLE "organization_post_author" (
	"post_id" uuid PRIMARY KEY,
	"organization_account_id" uuid NOT NULL,
	"member_account_id" uuid NOT NULL,
	"attribution_mode" "post_attribution_mode" DEFAULT 'acting_account_only'::"post_attribution_mode" NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "organization_post_author_self_check" CHECK ("organization_account_id" <> "member_account_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "kind" "account_kind" DEFAULT 'personal'::"account_kind" NOT NULL;--> statement-breakpoint
CREATE INDEX "organization_conversion_request_admin_idx" ON "organization_conversion_request" ("admin_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_conversion_request_pending_account_idx" ON "organization_conversion_request" ("account_id") WHERE ("accepted" is null);--> statement-breakpoint
CREATE INDEX "organization_membership_member_idx" ON "organization_membership" ("member_account_id");--> statement-breakpoint
CREATE INDEX "organization_membership_organization_role_idx" ON "organization_membership" ("organization_account_id","role");--> statement-breakpoint
CREATE INDEX "organization_notification_read_member_idx" ON "organization_notification_read" ("member_account_id");--> statement-breakpoint
CREATE INDEX "organization_post_author_organization_idx" ON "organization_post_author" ("organization_account_id");--> statement-breakpoint
CREATE INDEX "organization_post_author_member_idx" ON "organization_post_author" ("member_account_id");--> statement-breakpoint
ALTER TABLE "organization_conversion_request" ADD CONSTRAINT "organization_conversion_request_account_id_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_conversion_request" ADD CONSTRAINT "organization_conversion_request_m9gY7o4LngOo_fkey" FOREIGN KEY ("admin_account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_organization_account_id_account_id_fkey" FOREIGN KEY ("organization_account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_member_account_id_account_id_fkey" FOREIGN KEY ("member_account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_invited_by_id_account_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "organization_notification_read" ADD CONSTRAINT "organization_notification_read_eshHDNx0YK00_fkey" FOREIGN KEY ("organization_account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_notification_read" ADD CONSTRAINT "organization_notification_read_FaWR1bypTwkX_fkey" FOREIGN KEY ("member_account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_post_author" ADD CONSTRAINT "organization_post_author_post_id_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_post_author" ADD CONSTRAINT "organization_post_author_xvxV0edtHJ7A_fkey" FOREIGN KEY ("organization_account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_post_author" ADD CONSTRAINT "organization_post_author_member_account_id_account_id_fkey" FOREIGN KEY ("member_account_id") REFERENCES "account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE 'organization_conversion_request';
