CREATE OR REPLACE FUNCTION json_sum_object_Values(input_jsonb jsonb)
  RETURNS integer
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  AS $$
    SELECT coalesce(sum(value::integer), 0)
    FROM jsonb_each(input_jsonb)
    WHERE jsonb_typeof(value) = 'number';
  $$;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "reactionsCount" integer GENERATED ALWAYS AS (json_sum_object_values("post"."reactions_counts")) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "post" DROP COLUMN "likes_count";--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_reactions_acounts_check" CHECK ("post"."reactions_counts" IS JSON OBJECT);
