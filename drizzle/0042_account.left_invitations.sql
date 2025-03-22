ALTER TABLE "account" ADD COLUMN "left_invitations" smallint;--> statement-breakpoint
UPDATE "account" SET "left_invitations" = 0 WHERE "left_invitations" IS NULL;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "left_invitations" SET NOT NULL;
