CREATE TABLE "blocking" (
	"id" uuid PRIMARY KEY NOT NULL,
	"iri" text NOT NULL,
	"blocker_id" uuid NOT NULL,
	"blockee_id" uuid NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "blocking_iri_unique" UNIQUE("iri"),
	CONSTRAINT "blocking_blocker_id_blockee_id_unique" UNIQUE("blocker_id","blockee_id"),
	CONSTRAINT "blocking_blocker_blockee_check" CHECK ("blocking"."blocker_id" != "blocking"."blockee_id")
);
--> statement-breakpoint
ALTER TABLE "blocking" ADD CONSTRAINT "blocking_blocker_id_actor_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocking" ADD CONSTRAINT "blocking_blockee_id_actor_id_fk" FOREIGN KEY ("blockee_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;