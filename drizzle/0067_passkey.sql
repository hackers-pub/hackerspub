CREATE TYPE "public"."passkey_device_type" AS ENUM('singleDevice', 'multiDevice');--> statement-breakpoint
CREATE TYPE "public"."passkey_transport" AS ENUM('ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb');--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"public_key" "bytea" NOT NULL,
	"webauthn_user_id" text NOT NULL,
	"counter" bigint NOT NULL,
	"device_type" "passkey_device_type" NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" "passkey_transport"[],
	CONSTRAINT "passkey_account_id_webauthn_user_id_unique" UNIQUE("account_id","webauthn_user_id")
);
--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkey_account_id_index" ON "passkey" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "passkey_webauthn_user_id_index" ON "passkey" USING btree ("webauthn_user_id");