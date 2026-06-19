CREATE TABLE "deleted_account_key" (
	"account_id" uuid,
	"type" "account_key_type",
	"public" jsonb NOT NULL,
	"private" jsonb NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "deleted_account_key_pkey" PRIMARY KEY("account_id","type"),
	CONSTRAINT "deleted_account_key_public_check" CHECK (jsonb_typeof("public") = 'object'),
	CONSTRAINT "deleted_account_key_private_check" CHECK (jsonb_typeof("private") = 'object')
);
--> statement-breakpoint
ALTER TABLE "deleted_account_key" ADD CONSTRAINT "deleted_account_key_account_id_deleted_account_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "deleted_account"("account_id") ON DELETE CASCADE;
