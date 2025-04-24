ALTER TABLE "post" ADD CONSTRAINT "post_id_actor_id_unique" UNIQUE("id","actor_id");--> statement-breakpoint
CREATE TABLE "pin" (
	"post_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "pin_post_id_actor_id_pk" PRIMARY KEY("post_id","actor_id")
);
--> statement-breakpoint
ALTER TABLE "pin" ADD CONSTRAINT "pin_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin" ADD CONSTRAINT "pin_post_id_actor_id_post_id_actor_id_fk" FOREIGN KEY ("post_id","actor_id") REFERENCES "public"."post"("id","actor_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pin_actor_id_index" ON "pin" USING btree ("actor_id");
