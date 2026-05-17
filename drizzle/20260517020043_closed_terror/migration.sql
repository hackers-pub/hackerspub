CREATE TABLE "quote_request" (
	"id" uuid PRIMARY KEY,
	"iri" text NOT NULL UNIQUE,
	"quote_post_id" uuid NOT NULL,
	"quoted_post_id" uuid NOT NULL,
	"accepted" timestamp with time zone,
	"rejected" timestamp with time zone,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "quote_request_quote_post_id_index" ON "quote_request" ("quote_post_id");--> statement-breakpoint
CREATE INDEX "quote_request_quoted_post_id_index" ON "quote_request" ("quoted_post_id");--> statement-breakpoint
ALTER TABLE "quote_request" ADD CONSTRAINT "quote_request_quote_post_id_post_id_fkey" FOREIGN KEY ("quote_post_id") REFERENCES "post"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "quote_request" ADD CONSTRAINT "quote_request_quoted_post_id_post_id_fkey" FOREIGN KEY ("quoted_post_id") REFERENCES "post"("id") ON DELETE CASCADE;