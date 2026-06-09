ALTER TYPE "notification_type" ADD VALUE 'poll_ended';--> statement-breakpoint
ALTER TABLE "poll" ADD COLUMN "ended_notifications_sent" timestamp with time zone;
