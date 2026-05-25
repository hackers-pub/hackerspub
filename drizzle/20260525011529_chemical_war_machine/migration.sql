CREATE TABLE "hashtag_following" (
	"account_id" uuid,
	"tag" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "hashtag_following_pkey" PRIMARY KEY("account_id","tag")
);
--> statement-breakpoint
ALTER TABLE "hashtag_following" ADD CONSTRAINT "hashtag_following_account_id_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE;