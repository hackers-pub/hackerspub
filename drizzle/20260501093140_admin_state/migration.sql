CREATE TABLE "admin_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
