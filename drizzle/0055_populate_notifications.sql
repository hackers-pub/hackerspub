-- Populate notifications table with existing data

-- Create a function to generate timestamp-based UUIDs
CREATE OR REPLACE FUNCTION time_ordered_uuid() RETURNS uuid AS $$
DECLARE
  v_time timestamp with time zone := current_timestamp;
  v_secs bigint;
  v_usec bigint;
  v_uuid uuid;
  v_hex text;
BEGIN
  -- Extract seconds and microseconds from current timestamp
  v_secs := EXTRACT(EPOCH FROM v_time);
  v_usec := mod(EXTRACT(MICROSECONDS FROM v_time)::bigint, 1000000);
  
  -- Generate a UUID using v4 (random) method
  v_uuid := gen_random_uuid();
  v_hex := replace(v_uuid::text, '-', '');
  
  -- Prepare timestamp portion - 6 bytes = 12 hex digits
  -- This uses 32 bits for seconds (enough until 2106) and 16 bits for microseconds
  v_hex := lpad(to_hex(v_secs), 8, '0') || lpad(to_hex(v_usec), 4, '0') || substring(v_hex from 13);
  
  -- Re-format as UUID with hyphens
  RETURN (
    substring(v_hex for 8) || '-' ||
    substring(v_hex from 9 for 4) || '-' ||
    substring(v_hex from 13 for 4) || '-' ||
    substring(v_hex from 17 for 4) || '-' ||
    substring(v_hex from 21)
  )::uuid;
END;
$$ LANGUAGE plpgsql;

-- For follow notifications
INSERT INTO notification (id, account_id, type, post_id, actor_ids, created)
SELECT 
  time_ordered_uuid(), -- Time-ordered UUID
  a.account_id, -- Account that was followed
  'follow', -- Type of notification (follow)
  NULL, -- post_id is NULL for follow notifications
  ARRAY[f.follower_id], -- Actor IDs who followed
  f.created -- Use creation date of follow relationship
FROM 
  following f
JOIN 
  actor a ON f.followee_id = a.id
WHERE 
  a.account_id IS NOT NULL -- Only for local users
  AND f.accepted IS NOT NULL -- Only accepted follow relationships
ON CONFLICT (account_id, type, post_id) DO NOTHING;

-- For mention notifications (excluding mentions in replies and quotes to avoid duplicate notifications)
INSERT INTO notification (id, account_id, type, post_id, actor_ids, created)
SELECT 
  time_ordered_uuid(), -- Time-ordered UUID
  a_mentioned.account_id, -- Account that was mentioned
  'mention', -- Type of notification (mention)
  m.post_id, -- Post where the mention occurred
  ARRAY[p.actor_id], -- Actor ID who mentioned
  p.published -- Use post publication date
FROM 
  mention m
JOIN 
  actor a_mentioned ON m.actor_id = a_mentioned.id
JOIN 
  post p ON m.post_id = p.id
JOIN
  actor a_mentioner ON p.actor_id = a_mentioner.id
WHERE 
  a_mentioned.account_id IS NOT NULL -- Only for local users
  AND (a_mentioner.account_id IS NULL OR a_mentioned.account_id != a_mentioner.account_id) -- Exclude self-mentions
  AND NOT EXISTS ( -- Exclude mentions in direct replies to the mentioned user's posts
    SELECT 1 FROM post p_original 
    WHERE p.reply_target_id = p_original.id AND p_original.actor_id = m.actor_id
  )
  AND NOT EXISTS ( -- Exclude mentions in quotes of the mentioned user's posts
    SELECT 1 FROM post p_original 
    WHERE p.quoted_post_id = p_original.id AND p_original.actor_id = m.actor_id
  )
ON CONFLICT (account_id, type, post_id) DO NOTHING;

-- For reply notifications
INSERT INTO notification (id, account_id, type, post_id, actor_ids, created)
SELECT 
  time_ordered_uuid(), -- Time-ordered UUID
  a_original.account_id, -- Account of the original post author
  'reply', -- Type of notification (reply)
  p_reply.id, -- Reply post ID
  ARRAY[p_reply.actor_id], -- Actor ID who replied
  p_reply.published -- Use reply publication date
FROM 
  post p_reply
JOIN 
  post p_original ON p_reply.reply_target_id = p_original.id
JOIN 
  actor a_original ON p_original.actor_id = a_original.id
WHERE 
  p_reply.reply_target_id IS NOT NULL -- Only replies
  AND a_original.account_id IS NOT NULL -- Only for local users
  AND a_original.account_id != (
    SELECT a_reply.account_id FROM actor a_reply WHERE a_reply.id = p_reply.actor_id
  ) -- Exclude self-replies
ON CONFLICT (account_id, type, post_id) DO NOTHING;

-- For share notifications
INSERT INTO notification (id, account_id, type, post_id, actor_ids, created)
SELECT 
  time_ordered_uuid(), -- Time-ordered UUID
  a_original.account_id, -- Account of the original post author
  'share', -- Type of notification (share)
  p_share.id, -- Share post ID
  ARRAY[p_share.actor_id], -- Actor ID who shared
  p_share.published -- Use share publication date
FROM 
  post p_share
JOIN 
  post p_original ON p_share.shared_post_id = p_original.id
JOIN 
  actor a_original ON p_original.actor_id = a_original.id
WHERE 
  p_share.shared_post_id IS NOT NULL -- Only shares
  AND a_original.account_id IS NOT NULL -- Only for local users
  AND a_original.account_id != (
    SELECT a_share.account_id FROM actor a_share WHERE a_share.id = p_share.actor_id
  ) -- Exclude self-shares
ON CONFLICT (account_id, type, post_id) DO NOTHING;

-- For quote notifications
INSERT INTO notification (id, account_id, type, post_id, actor_ids, created)
SELECT 
  time_ordered_uuid(), -- Time-ordered UUID
  a_original.account_id, -- Account of the original post author
  'quote', -- Type of notification (quote)
  p_quote.id, -- Quote post ID
  ARRAY[p_quote.actor_id], -- Actor ID who quoted
  p_quote.published -- Use quote publication date
FROM 
  post p_quote
JOIN 
  post p_original ON p_quote.quoted_post_id = p_original.id
JOIN 
  actor a_original ON p_original.actor_id = a_original.id
WHERE 
  p_quote.quoted_post_id IS NOT NULL -- Only quotes
  AND a_original.account_id IS NOT NULL -- Only for local users
  AND a_original.account_id != (
    SELECT a_quote.account_id FROM actor a_quote WHERE a_quote.id = p_quote.actor_id
  ) -- Exclude self-quotes
ON CONFLICT (account_id, type, post_id) DO NOTHING;

-- Clean up the function
DROP FUNCTION IF EXISTS time_ordered_uuid();
