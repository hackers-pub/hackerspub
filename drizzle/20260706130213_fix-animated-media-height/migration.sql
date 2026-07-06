UPDATE "medium"
SET "height" = 897
WHERE "type" = 'image/webp'
  AND "width" = 490
  AND "height" IS DISTINCT FROM 897
  AND (
    "content_hash" = '7d990e9db26fd842c3e1cd419323826679e3e9ef2a58cbd8b6198157db5071fc'
    OR "key" IN (
      'media/7d990e9db26fd842c3e1cd419323826679e3e9ef2a58cbd8b6198157db5071fc.webp',
      '7d990e9db26fd842c3e1cd419323826679e3e9ef2a58cbd8b6198157db5071fc.webp'
    )
  );

UPDATE "post_medium"
SET "height" = 897
WHERE "type" = 'image/webp'
  AND "width" = 490
  AND "height" IS DISTINCT FROM 897
  AND "url" = 'https://media.hackers.pub/media/7d990e9db26fd842c3e1cd419323826679e3e9ef2a58cbd8b6198157db5071fc.webp';
