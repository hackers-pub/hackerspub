ALTER TABLE "notification" DROP CONSTRAINT "notification_post_id_check", ADD CONSTRAINT "notification_post_id_check" CHECK (
        CASE "type"::text
          WHEN 'follow' THEN "post_id" IS NULL
          WHEN 'organization_invitation' THEN "post_id" IS NULL
          WHEN 'organization_conversion_request'
          THEN "post_id" IS NULL
          ELSE "post_id" IS NOT NULL
        END
      );
