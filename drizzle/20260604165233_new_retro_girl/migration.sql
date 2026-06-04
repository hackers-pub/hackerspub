CREATE TABLE "news_rescore_queue" (
	"actor_id" uuid PRIMARY KEY,
	"enqueued" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"claimed_at" timestamp with time zone,
	"dirty" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news_rescore_queue" ADD CONSTRAINT "news_rescore_queue_actor_id_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actor"("id") ON DELETE CASCADE;