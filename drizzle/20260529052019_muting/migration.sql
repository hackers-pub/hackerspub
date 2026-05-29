CREATE TABLE "muting" (
	"id" uuid PRIMARY KEY,
	"muter_id" uuid NOT NULL,
	"mutee_id" uuid NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "muting_muter_id_mutee_id_unique" UNIQUE("muter_id","mutee_id"),
	CONSTRAINT "muting_muter_mutee_check" CHECK ("muter_id" != "mutee_id")
);
--> statement-breakpoint
CREATE INDEX "muting_mutee_id_index" ON "muting" ("mutee_id");--> statement-breakpoint
ALTER TABLE "muting" ADD CONSTRAINT "muting_muter_id_actor_id_fkey" FOREIGN KEY ("muter_id") REFERENCES "actor"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "muting" ADD CONSTRAINT "muting_mutee_id_actor_id_fkey" FOREIGN KEY ("mutee_id") REFERENCES "actor"("id") ON DELETE CASCADE;