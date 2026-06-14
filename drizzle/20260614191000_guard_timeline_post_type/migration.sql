CREATE OR REPLACE FUNCTION "fill_timeline_item_post_type"() RETURNS TRIGGER AS $$
DECLARE
  resolved_post_type "post_type";
BEGIN
  SELECT "type" INTO resolved_post_type FROM "post" WHERE "id" = NEW."post_id" FOR SHARE;
  IF resolved_post_type IS NOT NULL THEN
    NEW."post_type" := resolved_post_type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
