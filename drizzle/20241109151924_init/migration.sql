CREATE TYPE "public"."account_type" AS ENUM('person', 'organization');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_email" (
	"email" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"verified" timestamp with time zone,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_link" (
	"account_id" uuid NOT NULL,
	"index" smallint NOT NULL,
	"name" varchar(50) NOT NULL,
	"url" text NOT NULL,
	"handle" text,
	"verified" timestamp with time zone,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "account_link_account_id_index_pk" PRIMARY KEY("account_id","index"),
	CONSTRAINT "account_link_name_check" CHECK (
        char_length("account_link"."name") <= 50 AND
        "account_link"."name" !~ '^[[:space:]]' AND
        "account_link"."name" !~ '[[:space:]]$'
      )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" varchar(50) NOT NULL,
	"name" varchar(50) NOT NULL,
	"bio" text NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "account_username_unique" UNIQUE("username"),
	CONSTRAINT "account_username_check" CHECK ("account"."username" ~ '^[a-z0-9_]{1,50}$'),
	CONSTRAINT "account_name_check" CHECK (
        char_length("account"."name") <= 50 AND
        "account"."name" !~ '^[[:space:]]' AND
        "account"."name" !~ '[[:space:]]$'
      )
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_email" ADD CONSTRAINT "account_email_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_link" ADD CONSTRAINT "account_link_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
