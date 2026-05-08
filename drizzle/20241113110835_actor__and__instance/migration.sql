CREATE TYPE "public"."actor_type" AS ENUM('Application', 'Group', 'Organization', 'Person', 'Service');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "actor" (
	"id" uuid PRIMARY KEY NOT NULL,
	"iri" text NOT NULL,
	"type" "actor_type" NOT NULL,
	"username" text NOT NULL,
	"instance_host" text NOT NULL,
	"account_id" uuid,
	"name" text,
	"bio_html" text,
	"automatically_approves_followers" boolean DEFAULT false NOT NULL,
	"avatar_url" text,
	"header_url" text,
	"inbox_url" text NOT NULL,
	"shared_inbox_url" text,
	"followers_url" text,
	"featured_url" text,
	"field_htmls" json DEFAULT '{}'::json NOT NULL,
	"emojis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"successor_id" uuid,
	"aliases" text[] DEFAULT (ARRAY[]::text[]) NOT NULL,
	"followees_count" integer DEFAULT 0 NOT NULL,
	"followers_count" integer DEFAULT 0 NOT NULL,
	"posts_count" integer DEFAULT 0 NOT NULL,
	"url" text,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "actor_iri_unique" UNIQUE("iri"),
	CONSTRAINT "actor_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "actor_username_instance_host_unique" UNIQUE("username","instance_host")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "instance" (
	"host" text PRIMARY KEY NOT NULL,
	"software" text,
	"software_version" text,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "actor" ADD CONSTRAINT "actor_instance_host_instance_host_fk" FOREIGN KEY ("instance_host") REFERENCES "public"."instance"("host") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "actor" ADD CONSTRAINT "actor_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "actor" ADD CONSTRAINT "actor_successor_id_actor_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DROP TYPE "public"."account_type";