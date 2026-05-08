CREATE TABLE "fcm_device_token" (
	"device_token" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fcm_device_token" ADD CONSTRAINT "fcm_device_token_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fcm_device_token_account_id_index" ON "fcm_device_token" USING btree ("account_id");