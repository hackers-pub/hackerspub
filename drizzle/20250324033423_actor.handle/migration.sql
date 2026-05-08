ALTER TABLE "actor" ADD COLUMN "handle_host" text;--> statement-breakpoint
UPDATE "actor" SET "handle_host" = "instance_host" WHERE "handle_host" IS NULL;--> statement-breakpoint
ALTER TABLE "actor" ALTER COLUMN "handle_host" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "actor" ADD COLUMN "handle" text GENERATED ALWAYS AS ('@' || "actor"."username" || '@' || "actor"."handle_host") STORED;
