CREATE TYPE "public"."notification_type" AS ENUM('follow', 'mention', 'reply', 'share', 'quote');--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"post_id" uuid,
	"actor_ids" uuid[] DEFAULT (ARRAY[]::uuid[]) NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "notification_account_id_type_post_id_unique" UNIQUE("account_id","type","post_id"),
	CONSTRAINT "notification_post_id_check" CHECK (
        CASE "notification"."type"
          WHEN 'follow' THEN "notification"."post_id" IS NULL
          ELSE "notification"."post_id" IS NOT NULL
        END
      )
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_account_id_id" ON "notification" USING btree ("account_id","id" desc);