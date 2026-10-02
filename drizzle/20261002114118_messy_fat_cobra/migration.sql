CREATE TABLE "application_task_receipt" (
	"job_id" uuid PRIMARY KEY,
	"completed" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
