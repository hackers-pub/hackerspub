import assert from "node:assert/strict";
import test from "node:test";
import * as facade from "./post.ts";
import * as core from "./post/core.ts";
import * as engagement from "./post/engagement.ts";
import * as lifecycle from "./post/lifecycle.ts";
import * as remote from "./post/remote.ts";
import * as sharing from "./post/sharing.ts";
import * as source from "./post/source.ts";
import * as visibility from "./post/visibility.ts";
import * as linkPreview from "./link-preview.ts";

test("post compatibility facade re-exports each feature implementation", () => {
  assert.equal(facade.isPostObject, core.isPostObject);
  assert.equal(facade.getPersistedPost, core.getPersistedPost);
  assert.equal(facade.updateRepliesCount, engagement.updateRepliesCount);
  assert.equal(facade.revokeQuote, engagement.revokeQuote);
  assert.equal(facade.deletePost, lifecycle.deletePost);
  assert.equal(facade.persistPost, remote.persistPost);
  assert.equal(
    facade.withDocumentLoaderTimeout,
    remote.withDocumentLoaderTimeout,
  );
  assert.equal(facade.sharePost, sharing.sharePost);
  assert.equal(facade.syncPostFromNoteSource, source.syncPostFromNoteSource);
  assert.equal(facade.isPostVisibleTo, visibility.isPostVisibleTo);
  assert.equal(facade.persistPostLink, linkPreview.persistPostLink);
});
