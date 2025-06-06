CREATE TABLE "invitation_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"inviter_id" uuid NOT NULL,
	"invitations_left" smallint NOT NULL,
	"message" text,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expires" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "invitation_link" ADD CONSTRAINT "invitation_link_inviter_id_account_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;