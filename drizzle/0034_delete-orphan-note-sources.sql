DELETE FROM note_source
WHERE note_source.id NOT IN (
  SELECT post.note_source_id
  FROM post
  WHERE post.note_source_id IS NOT NULL
);
DELETE FROM article_source
WHERE article_source.id NOT IN (
  SELECT post.article_source_id
  FROM post
  WHERE post.article_source_id IS NOT NULL
);
