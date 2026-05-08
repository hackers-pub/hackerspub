CREATE TABLE IF NOT EXISTS "mention" (
	"post_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	CONSTRAINT "mention_post_id_actor_id_pk" PRIMARY KEY("post_id","actor_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mention" ADD CONSTRAINT "mention_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mention" ADD CONSTRAINT "mention_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
