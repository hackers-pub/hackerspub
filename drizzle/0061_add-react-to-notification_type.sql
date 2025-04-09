ALTER TABLE "notification" DROP CONSTRAINT "notification_account_id_type_post_id_unique";--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "custom_emoji_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_custom_emoji_id_custom_emoji_id_fk" FOREIGN KEY ("custom_emoji_id") REFERENCES "public"."custom_emoji"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_account_id_actor_ids_index" ON "notification" USING btree ("account_id","actor_ids") WHERE "notification"."type" = 'follow';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_account_id_post_id_index" ON "notification" USING btree ("account_id","post_id") WHERE "notification"."type" NOT IN ('follow', 'react');--> statement-breakpoint
CREATE UNIQUE INDEX "notification_account_id_post_id_emoji_index" ON "notification" USING btree ("account_id","post_id","emoji") WHERE "notification"."type" = 'react' AND "notification"."custom_emoji_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_account_id_post_id_custom_emoji_id_index" ON "notification" USING btree ("account_id","post_id","custom_emoji_id") WHERE "notification"."type" = 'react' AND "notification"."emoji" IS NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_emoji_check" CHECK (
        CASE "notification"."type"
          WHEN 'react'
          THEN "notification"."emoji" IS NOT NULL AND "notification"."custom_emoji_id" IS NULL
            OR "notification"."emoji" IS NULL AND "notification"."custom_emoji_id" IS NOT NULL
          ELSE "notification"."emoji" IS NULL AND "notification"."custom_emoji_id" IS NULL
        END
      );