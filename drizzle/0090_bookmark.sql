CREATE TABLE "bookmark" (
	"account_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "bookmark_account_id_post_id_pk" PRIMARY KEY("account_id","post_id")
);
--> statement-breakpoint
ALTER TABLE "bookmark" ADD CONSTRAINT "bookmark_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark" ADD CONSTRAINT "bookmark_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bookmark_account_created" ON "bookmark" USING btree ("account_id","created" desc);--> statement-breakpoint
CREATE INDEX "bookmark_post_id_index" ON "bookmark" USING btree ("post_id");