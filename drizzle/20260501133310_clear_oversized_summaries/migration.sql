-- Clear summaries that are not strictly shorter than the original
-- article content, mark those rows as `summary_unnecessary` so we don't
-- keep retrying summarization for them, and clear the duplicated post
-- summary for original-language rows.
--
-- Length is compared with PostgreSQL `char_length()`, which counts
-- Unicode code points.  The runtime check in `applyArticleContentSummary`
-- uses grapheme clusters via `Intl.Segmenter`, so for content with
-- multi-codepoint graphemes (e.g. emoji families joined with zero-width
-- joiners) this migration is a best-effort cleanup: it may leave a few
-- rows whose summary is fewer code points than the body but actually
-- equal or longer in user-perceived characters.  Those edge cases are
-- vanishingly rare in technical articles and can be cleared later by
-- editing the article (which resets summary state) or by running a
-- one-off application-side cleanup.
UPDATE "post" AS p
SET "summary" = NULL
FROM "article_content" AS ac
WHERE p."article_source_id" = ac."source_id"
  AND p."language" = ac."language"
  AND ac."original_language" IS NULL
  AND ac."summary" IS NOT NULL
  AND char_length(
        regexp_replace(ac."summary", '^[[:space:]]+|[[:space:]]+$', '', 'g')
      ) >= char_length(
        regexp_replace(ac."content", '^[[:space:]]+|[[:space:]]+$', '', 'g')
      );
--> statement-breakpoint
UPDATE "article_content"
SET "summary" = NULL,
    "summary_unnecessary" = TRUE,
    "summary_started" = NULL
WHERE "summary" IS NOT NULL
  AND char_length(
        regexp_replace("summary", '^[[:space:]]+|[[:space:]]+$', '', 'g')
      ) >= char_length(
        regexp_replace("content", '^[[:space:]]+|[[:space:]]+$', '', 'g')
      );
