import assert from "node:assert";
import test from "node:test";
import { arePostsBookmarkedBy, createBookmark } from "./bookmark.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test(
  "arePostsBookmarkedBy() returns the subset of posts the account bookmarked",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "arebookmarkedauthor",
        name: "AreBookmarked Author",
        email: "arebookmarkedauthor@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "arebookmarkedviewer",
        name: "AreBookmarked Viewer",
        email: "arebookmarkedviewer@example.com",
      });

      const { post: postA } = await insertNotePost(tx, {
        account: author.account,
        content: "A",
      });
      const { post: postB } = await insertNotePost(tx, {
        account: author.account,
        content: "B",
      });
      const { post: postC } = await insertNotePost(tx, {
        account: author.account,
        content: "C",
      });

      await createBookmark(tx, viewer.account, postA);
      await createBookmark(tx, viewer.account, postC);

      const result = await arePostsBookmarkedBy(
        tx,
        [postA.id, postB.id, postC.id],
        viewer.account,
      );

      assert.deepEqual(result, new Set([postA.id, postC.id]));
    });
  },
);

test(
  "arePostsBookmarkedBy() returns an empty set when no bookmarks match",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "arebookmarkednoneauthor",
        name: "AreBookmarked None Author",
        email: "arebookmarkednoneauthor@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "arebookmarkednoneviewer",
        name: "AreBookmarked None Viewer",
        email: "arebookmarkednoneviewer@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Untouched",
      });

      const result = await arePostsBookmarkedBy(
        tx,
        [post.id],
        viewer.account,
      );

      assert.deepEqual(result, new Set());
    });
  },
);

test(
  "arePostsBookmarkedBy() returns an empty set for an empty input list",
  async () => {
    await withRollback(async (tx) => {
      const viewer = await insertAccountWithActor(tx, {
        username: "arebookmarkedemptyviewer",
        name: "AreBookmarked Empty Viewer",
        email: "arebookmarkedemptyviewer@example.com",
      });

      const result = await arePostsBookmarkedBy(tx, [], viewer.account);

      assert.deepEqual(result, new Set());
    });
  },
);
