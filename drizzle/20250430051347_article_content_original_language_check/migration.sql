ALTER TABLE "article_content" ADD CONSTRAINT "article_content_original_language_check" CHECK ((
        "article_content"."translator_id" IS NULL AND
        "article_content"."translation_requester_id" IS NULL
      ) = ("article_content"."original_language" IS NULL));
