CREATE TABLE "flag" (
	"id" uuid PRIMARY KEY NOT NULL,
	"iri" text NOT NULL,
	"reporter_id" uuid NOT NULL,
	"post_id" uuid,
	"actor_id" uuid,
	"reason" text NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "flag_iri_unique" UNIQUE("iri"),
	CONSTRAINT "flag_reporter_id_post_id_unique" UNIQUE("reporter_id","post_id"),
	CONSTRAINT "flag_reporter_id_actor_id_unique" UNIQUE("reporter_id","actor_id"),
	CONSTRAINT "flag_target_check" CHECK (("flag"."post_id" IS NOT NULL AND "flag"."actor_id" IS NULL) OR ("flag"."post_id" IS NULL AND "flag"."actor_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "flag" ADD CONSTRAINT "flag_reporter_id_actor_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag" ADD CONSTRAINT "flag_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag" ADD CONSTRAINT "flag_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;
