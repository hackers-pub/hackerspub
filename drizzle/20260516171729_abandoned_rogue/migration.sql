CREATE TABLE "quote_authorization" (
	"id" uuid PRIMARY KEY,
	"iri" text NOT NULL UNIQUE,
	"quote_post_iri" text NOT NULL,
	"quote_post_id" uuid,
	"quoted_post_id" uuid NOT NULL,
	"attributed_actor_id" uuid NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "quote_authorization_quote_post_iri_index" ON "quote_authorization" ("quote_post_iri");--> statement-breakpoint
CREATE INDEX "quote_authorization_quote_post_id_index" ON "quote_authorization" ("quote_post_id");--> statement-breakpoint
CREATE INDEX "quote_authorization_quoted_post_id_index" ON "quote_authorization" ("quoted_post_id");--> statement-breakpoint
ALTER TABLE "quote_authorization" ADD CONSTRAINT "quote_authorization_quote_post_id_post_id_fkey" FOREIGN KEY ("quote_post_id") REFERENCES "post"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "quote_authorization" ADD CONSTRAINT "quote_authorization_quoted_post_id_post_id_fkey" FOREIGN KEY ("quoted_post_id") REFERENCES "post"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quote_authorization" ADD CONSTRAINT "quote_authorization_attributed_actor_id_actor_id_fkey" FOREIGN KEY ("attributed_actor_id") REFERENCES "actor"("id") ON DELETE CASCADE;