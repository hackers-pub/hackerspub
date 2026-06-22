ALTER TYPE "notification_type" ADD VALUE 'organization_conversion_request';--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "organization_conversion_request_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_organization_conversion_request_idx" ON "notification" ("account_id","type","organization_conversion_request_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_ITxxKJTAFYFZ_fkey" FOREIGN KEY ("organization_conversion_request_id") REFERENCES "organization_conversion_request"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_conversion_request_id_check" CHECK (
        CASE "type"::text
          WHEN 'organization_conversion_request'
          THEN "organization_conversion_request_id" IS NOT NULL
          ELSE "organization_conversion_request_id" IS NULL
        END
      );--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_post_id_check", ADD CONSTRAINT "notification_post_id_check" CHECK (
        CASE "type"::text
          WHEN 'follow' THEN "post_id" IS NULL
          WHEN 'organization_conversion_request'
          THEN "post_id" IS NULL
          ELSE "post_id" IS NOT NULL
        END
      );
