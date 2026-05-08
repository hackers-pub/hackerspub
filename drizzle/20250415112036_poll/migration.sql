CREATE TABLE "poll_option" (
	"post_id" uuid NOT NULL,
	"index" smallint NOT NULL,
	"title" text NOT NULL,
	"votes_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "poll_option_post_id_index_pk" PRIMARY KEY("post_id","index"),
	CONSTRAINT "poll_option_index_check" CHECK ("poll_option"."index" >= 0),
	CONSTRAINT "poll_option_votes_count_check" CHECK ("poll_option"."votes_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "poll" (
	"post_id" uuid PRIMARY KEY NOT NULL,
	"multiple" boolean NOT NULL,
	"voters_count" integer DEFAULT 0 NOT NULL,
	"ends" timestamp with time zone NOT NULL,
	CONSTRAINT "poll_voters_count_check" CHECK ("poll"."voters_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "poll_vote" (
	"post_id" uuid NOT NULL,
	"option_index" smallint NOT NULL,
	"actor_id" uuid NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "poll_vote_post_id_option_index_actor_id_pk" PRIMARY KEY("post_id","option_index","actor_id")
);
--> statement-breakpoint
ALTER TABLE "poll_option" ADD CONSTRAINT "poll_option_post_id_poll_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."poll"("post_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll" ADD CONSTRAINT "poll_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_post_id_poll_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."poll"("post_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_post_id_option_index_poll_option_post_id_index_fk" FOREIGN KEY ("post_id","option_index") REFERENCES "public"."poll_option"("post_id","index") ON DELETE no action ON UPDATE no action;