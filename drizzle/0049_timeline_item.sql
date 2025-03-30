CREATE TABLE "timeline_item" (
	"account_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"last_sharer_id" uuid,
	"sharers_count" integer DEFAULT 0 NOT NULL,
	"added" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "timeline_item_account_id_post_id_pk" PRIMARY KEY("account_id","post_id")
);
--> statement-breakpoint
ALTER TABLE "timeline_item" ADD CONSTRAINT "timeline_item_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_item" ADD CONSTRAINT "timeline_item_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_item" ADD CONSTRAINT "timeline_item_last_sharer_id_actor_id_fk" FOREIGN KEY ("last_sharer_id") REFERENCES "public"."actor"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_timeline_item_account_id_added" ON "timeline_item" USING btree ("account_id","added" desc);