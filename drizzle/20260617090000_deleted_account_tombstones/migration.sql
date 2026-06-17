CREATE TABLE "deleted_account" (
  "account_id" uuid PRIMARY KEY NOT NULL,
  "username" varchar(50) NOT NULL,
  "actor_iri" text NOT NULL,
  "deleted" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "deleted_account_username_unique" UNIQUE("username"),
  CONSTRAINT "deleted_account_actor_iri_unique" UNIQUE("actor_iri"),
  CONSTRAINT "deleted_account_username_check" CHECK ("deleted_account"."username" ~ '^[a-z0-9_]{1,50}$')
);
