CREATE TABLE "apns_device_token" (
	"device_token" varchar(64) PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "apns_device_token_device_token_check" CHECK ("apns_device_token"."device_token" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "apns_device_token" ADD CONSTRAINT "apns_device_token_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apns_device_token_account_id_index" ON "apns_device_token" USING btree ("account_id");