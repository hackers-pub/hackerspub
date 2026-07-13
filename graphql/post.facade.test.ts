import assert from "node:assert/strict";
import test from "node:test";
import * as facade from "./post.ts";
import * as article from "./post/article.ts";
import * as core from "./post/core.ts";
import * as note from "./post/note.ts";

test("post compatibility facade preserves its public GraphQL references", () => {
  assert.deepEqual(Object.keys(facade).sort(), [
    "Article",
    "ArticleContent",
    "ArticleDraft",
    "Medium",
    "Note",
    "Post",
    "PostLink",
    "PostType",
    "Question",
    "hidePostRelationWithoutActor",
    "isPostVisibleToViewer",
  ]);
  assert.equal(facade.Post, core.Post);
  assert.equal(facade.Medium, core.Medium);
  assert.equal(facade.Note, note.Note);
  assert.equal(facade.Question, note.Question);
  assert.equal(facade.Article, article.Article);
  assert.equal(facade.ArticleContent, article.ArticleContent);
  assert.equal(facade.ArticleDraft, article.ArticleDraft);
});
