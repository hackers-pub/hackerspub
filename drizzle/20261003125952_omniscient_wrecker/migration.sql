CREATE TABLE "scheduled_worker_dispatch" (
	"job_name" text PRIMARY KEY,
	"scheduled" timestamp with time zone NOT NULL
);
