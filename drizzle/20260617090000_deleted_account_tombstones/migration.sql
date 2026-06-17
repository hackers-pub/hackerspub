CREATE TABLE "deleted_account" (
  "account_id" uuid PRIMARY KEY,
  "username" varchar(50) NOT NULL UNIQUE,
  "actor_iri" text NOT NULL UNIQUE,
  "deleted" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "deleted_account_username_check" CHECK ("username" ~ '^[a-z0-9_]{1,50}$')
);
