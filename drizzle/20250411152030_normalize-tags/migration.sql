-- Normalize tags in the post table by converting all tag names to lowercase
UPDATE post
SET tags = (
  SELECT jsonb_object_agg(lower(key), value)
  FROM jsonb_each_text(tags)
)
WHERE tags != '{}';
