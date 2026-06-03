CREATE TABLE "relay_subscription" (
	"id" uuid PRIMARY KEY,
	"actor_id" uuid NOT NULL UNIQUE,
	"follow_iri" text NOT NULL UNIQUE,
	"accepted" timestamp with time zone,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_subscription" ADD CONSTRAINT "relay_subscription_actor_id_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actor"("id") ON DELETE CASCADE;