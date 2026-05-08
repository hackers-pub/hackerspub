CREATE TABLE IF NOT EXISTS "following" (
	"iri" text PRIMARY KEY NOT NULL,
	"follower_id" uuid NOT NULL,
	"followee_id" uuid NOT NULL,
	"accepted" timestamp with time zone,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "following_follower_id_followee_id_unique" UNIQUE("follower_id","followee_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "following" ADD CONSTRAINT "following_follower_id_actor_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "following" ADD CONSTRAINT "following_followee_id_actor_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."actor"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
