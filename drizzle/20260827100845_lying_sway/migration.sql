CREATE TYPE "article_delivery_channel" AS ENUM('direct', 'relay');--> statement-breakpoint
CREATE TYPE "article_delivery_status" AS ENUM('pending', 'accepted', 'failed');--> statement-breakpoint
CREATE TYPE "article_referrer_category" AS ENUM('hackers_pub', 'search', 'fediverse', 'other_external', 'direct_or_unknown');--> statement-breakpoint
CREATE TABLE "article_delivery_event" (
	"message_id" text PRIMARY KEY,
	"article_source_id" uuid NOT NULL,
	"channel" "article_delivery_channel" NOT NULL,
	"server_key" bytea NOT NULL,
	"status" "article_delivery_status" DEFAULT 'pending'::"article_delivery_status" NOT NULL,
	"attempted" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "article_delivery_event_server_key_check" CHECK (octet_length("server_key") = 32)
);
--> statement-breakpoint
CREATE TABLE "article_publication_analytics" (
	"article_source_id" uuid PRIMARY KEY,
	"create_activity_iri" text NOT NULL UNIQUE,
	"remote_followers" integer NOT NULL,
	"published" timestamp with time zone NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "article_publication_analytics_remote_followers_check" CHECK ("remote_followers" >= 0)
);
--> statement-breakpoint
CREATE TABLE "article_view_daily" (
	"article_source_id" uuid,
	"day" date,
	"views" integer DEFAULT 0 NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "article_view_daily_pkey" PRIMARY KEY("article_source_id","day"),
	CONSTRAINT "article_view_daily_views_check" CHECK ("views" >= 0)
);
--> statement-breakpoint
CREATE TABLE "article_view_deduplication" (
	"article_source_id" uuid,
	"token_hash" bytea,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "article_view_deduplication_pkey" PRIMARY KEY("article_source_id","token_hash"),
	CONSTRAINT "article_view_deduplication_token_hash_check" CHECK (octet_length("token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "article_view_language_daily" (
	"article_source_id" uuid,
	"day" date,
	"language" varchar,
	"original" boolean,
	"views" integer DEFAULT 0 NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "article_view_language_daily_pkey" PRIMARY KEY("article_source_id","day","language","original"),
	CONSTRAINT "article_view_language_daily_views_check" CHECK ("views" >= 0)
);
--> statement-breakpoint
CREATE TABLE "article_view_referrer_daily" (
	"article_source_id" uuid,
	"day" date,
	"category" "article_referrer_category",
	"domain" text DEFAULT '',
	"views" integer DEFAULT 0 NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "article_view_referrer_daily_pkey" PRIMARY KEY("article_source_id","day","category","domain"),
	CONSTRAINT "article_view_referrer_daily_domain_check" CHECK (CASE
        WHEN "category" = 'other_external'
          THEN "domain" <> ''
        ELSE "domain" = ''
      END),
	CONSTRAINT "article_view_referrer_daily_views_check" CHECK ("views" >= 0)
);
--> statement-breakpoint
CREATE INDEX "article_delivery_event_article_source_id_channel_server_key_index" ON "article_delivery_event" ("article_source_id","channel","server_key");--> statement-breakpoint
CREATE INDEX "article_view_deduplication_expires_index" ON "article_view_deduplication" ("expires");--> statement-breakpoint
ALTER TABLE "article_delivery_event" ADD CONSTRAINT "article_delivery_event_article_source_id_article_source_id_fkey" FOREIGN KEY ("article_source_id") REFERENCES "article_source"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_publication_analytics" ADD CONSTRAINT "article_publication_analytics_aSjzxfSfE6ic_fkey" FOREIGN KEY ("article_source_id") REFERENCES "article_source"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_view_daily" ADD CONSTRAINT "article_view_daily_article_source_id_article_source_id_fkey" FOREIGN KEY ("article_source_id") REFERENCES "article_source"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_view_deduplication" ADD CONSTRAINT "article_view_deduplication_mlUEKp8q00vQ_fkey" FOREIGN KEY ("article_source_id") REFERENCES "article_source"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_view_language_daily" ADD CONSTRAINT "article_view_language_daily_xD9qwpFVu5Gb_fkey" FOREIGN KEY ("article_source_id") REFERENCES "article_source"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "article_view_referrer_daily" ADD CONSTRAINT "article_view_referrer_daily_22zTtT1H64dq_fkey" FOREIGN KEY ("article_source_id") REFERENCES "article_source"("id") ON DELETE CASCADE;