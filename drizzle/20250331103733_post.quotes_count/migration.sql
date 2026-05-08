ALTER TABLE "post" ADD COLUMN "quotes_count" integer DEFAULT 0 NOT NULL;

-- Update quotes_count for existing posts
WITH quote_counts AS (
  SELECT 
    quoted_post_id, 
    COUNT(*) AS count 
  FROM "post" 
  WHERE quoted_post_id IS NOT NULL 
  GROUP BY quoted_post_id
)
UPDATE "post" 
SET quotes_count = quote_counts.count
FROM quote_counts
WHERE "post".id = quote_counts.quoted_post_id;