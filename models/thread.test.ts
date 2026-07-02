import { eq } from "drizzle-orm";
import assert from "node:assert";
import test from "node:test";
import {
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";
import { postTable } from "./schema.ts";
import { getAncestorChain, getDescendantPage } from "./thread.ts";
import type { Uuid } from "./uuid.ts";

test("getAncestorChain() walks the chain nearest-first", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "threadancestors",
      name: "Thread Ancestors",
      email: "threadancestors@example.com",
    });
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
    });
    const { post: middle } = await insertNotePost(tx, {
      account: author.account,
      content: "middle",
      replyTargetId: root.id,
    });
    const { post: leaf } = await insertNotePost(tx, {
      account: author.account,
      content: "leaf",
      replyTargetId: middle.id,
    });

    const chain = await getAncestorChain(tx, leaf.id);
    assert.deepEqual(
      chain,
      [{ id: middle.id, depth: 1 }, { id: root.id, depth: 2 }],
    );

    assert.deepEqual(await getAncestorChain(tx, root.id), []);
  });
});

test("getAncestorChain() respects the limit option", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "threadancestorslimit",
      name: "Thread Ancestors Limit",
      email: "threadancestorslimit@example.com",
    });
    let parentId: Uuid | undefined;
    const ids: Uuid[] = [];
    for (let i = 0; i < 5; i++) {
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: `post ${i}`,
        replyTargetId: parentId,
      });
      ids.push(post.id);
      parentId = post.id;
    }

    const chain = await getAncestorChain(tx, ids[4], { limit: 3 });
    assert.deepEqual(chain.map((entry) => entry.id), [
      ids[3],
      ids[2],
      ids[1],
    ]);
  });
});

test("getAncestorChain() terminates on reply cycles", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "threadancestorcycle",
      name: "Thread Ancestor Cycle",
      email: "threadancestorcycle@example.com",
    });
    const { post: a } = await insertNotePost(tx, {
      account: author.account,
      content: "a",
    });
    const { post: b } = await insertNotePost(tx, {
      account: author.account,
      content: "b",
      replyTargetId: a.id,
    });
    // Forge a cycle: a replies to b while b replies to a.
    await tx.update(postTable)
      .set({ replyTargetId: b.id })
      .where(eq(postTable.id, a.id));
    const { post: leaf } = await insertNotePost(tx, {
      account: author.account,
      content: "leaf",
      replyTargetId: a.id,
    });

    const chain = await getAncestorChain(tx, leaf.id);
    assert.deepEqual(chain.map((entry) => entry.id), [a.id, b.id]);
  });
});

test("getAncestorChain() never returns the starting post for a self-reply", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "threadselfreply",
      name: "Thread Self Reply",
      email: "threadselfreply@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "self",
    });
    // Forge a self-reply.
    await tx.update(postTable)
      .set({ replyTargetId: post.id })
      .where(eq(postTable.id, post.id));

    assert.deepEqual(await getAncestorChain(tx, post.id), []);
  });
});

test("getDescendantPage() flattens the subtree depth-first", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "threaddescendants",
      name: "Thread Descendants",
      email: "threaddescendants@example.com",
    });
    const at = (minute: number) =>
      new Date(`2026-04-15T00:${String(minute).padStart(2, "0")}:00.000Z`);
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
      published: at(0),
    });
    const { post: r1 } = await insertNotePost(tx, {
      account: author.account,
      content: "r1",
      replyTargetId: root.id,
      published: at(1),
    });
    const { post: r2 } = await insertNotePost(tx, {
      account: author.account,
      content: "r2",
      replyTargetId: root.id,
      published: at(4),
    });
    const { post: r1a } = await insertNotePost(tx, {
      account: author.account,
      content: "r1a",
      replyTargetId: r1.id,
      published: at(3),
    });
    const { post: r1b } = await insertNotePost(tx, {
      account: author.account,
      content: "r1b",
      replyTargetId: r1.id,
      published: at(2),
    });

    const page = await getDescendantPage(tx, root.id, {
      limit: 10,
      maxDepth: 20,
    });
    assert.equal(page.hasMore, false);
    // r1's subtree is contiguous before r2; r1's replies are chronological
    // (r1b before r1a).
    assert.deepEqual(
      page.entries.map((entry) => [entry.id, entry.parentId, entry.depth]),
      [
        [r1.id, root.id, 1],
        [r1b.id, r1.id, 2],
        [r1a.id, r1.id, 2],
        [r2.id, root.id, 1],
      ],
    );
  });
});

test("getDescendantPage() resumes from a cursor across subtrees", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "threaddescpage",
      name: "Thread Desc Page",
      email: "threaddescpage@example.com",
    });
    const at = (minute: number) =>
      new Date(`2026-04-15T00:${String(minute).padStart(2, "0")}:00.000Z`);
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
      published: at(0),
    });
    const { post: r1 } = await insertNotePost(tx, {
      account: author.account,
      content: "r1",
      replyTargetId: root.id,
      published: at(1),
    });
    const { post: r1a } = await insertNotePost(tx, {
      account: author.account,
      content: "r1a",
      replyTargetId: r1.id,
      published: at(2),
    });
    const { post: r2 } = await insertNotePost(tx, {
      account: author.account,
      content: "r2",
      replyTargetId: root.id,
      published: at(3),
    });

    const first = await getDescendantPage(tx, root.id, {
      limit: 2,
      maxDepth: 20,
    });
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.entries.map((entry) => entry.id), [r1.id, r1a.id]);

    const second = await getDescendantPage(tx, root.id, {
      after: first.entries[1].cursor,
      limit: 2,
      maxDepth: 20,
    });
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.entries.map((entry) => entry.id), [r2.id]);
  });
});

test("getDescendantPage() caps traversal at maxDepth", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "threaddescdepth",
      name: "Thread Desc Depth",
      email: "threaddescdepth@example.com",
    });
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
    });
    const { post: child } = await insertNotePost(tx, {
      account: author.account,
      content: "child",
      replyTargetId: root.id,
    });
    await insertNotePost(tx, {
      account: author.account,
      content: "grandchild",
      replyTargetId: child.id,
    });

    const page = await getDescendantPage(tx, root.id, {
      limit: 10,
      maxDepth: 1,
    });
    assert.deepEqual(page.entries.map((entry) => entry.id), [child.id]);
  });
});

test("getDescendantPage() breaks sibling timestamp ties by post id", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "threaddesctie",
      name: "Thread Desc Tie",
      email: "threaddesctie@example.com",
    });
    const when = new Date("2026-04-15T00:01:00.000Z");
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
    });
    const { post: first } = await insertNotePost(tx, {
      account: author.account,
      content: "first",
      replyTargetId: root.id,
      published: when,
    });
    const { post: second } = await insertNotePost(tx, {
      account: author.account,
      content: "second",
      replyTargetId: root.id,
      published: when,
    });
    // insertNotePost() generates ascending UUIDv7 ids, so the tiebreak
    // order equals the insertion order.
    assert.ok(first.id < second.id);

    const page = await getDescendantPage(tx, root.id, {
      limit: 10,
      maxDepth: 20,
    });
    assert.deepEqual(page.entries.map((entry) => entry.id), [
      first.id,
      second.id,
    ]);
  });
});

test("getDescendantPage() prunes censored subtrees, except for the author", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "threaddesccensor",
      name: "Thread Desc Censor",
      email: "threaddesccensor@example.com",
    });
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
    });
    const { post: censored } = await insertNotePost(tx, {
      account: author.account,
      content: "censored",
      replyTargetId: root.id,
    });
    const { post: buried } = await insertNotePost(tx, {
      account: author.account,
      content: "buried",
      replyTargetId: censored.id,
    });
    await tx.update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, censored.id));

    const anonymous = await getDescendantPage(tx, root.id, {
      limit: 10,
      maxDepth: 20,
    });
    assert.deepEqual(anonymous.entries, []);

    const own = await getDescendantPage(tx, root.id, {
      limit: 10,
      maxDepth: 20,
      viewerActorId: author.account.actor.id,
    });
    assert.deepEqual(own.entries.map((entry) => entry.id), [
      censored.id,
      buried.id,
    ]);
  });
});

test("getDescendantPage() terminates on cycles and never re-emits the root", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "threaddesccycle",
      name: "Thread Desc Cycle",
      email: "threaddesccycle@example.com",
    });
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
    });
    const { post: x } = await insertNotePost(tx, {
      account: author.account,
      content: "x",
      replyTargetId: root.id,
    });
    const { post: y } = await insertNotePost(tx, {
      account: author.account,
      content: "y",
      replyTargetId: x.id,
    });
    // Forge a cycle through the root: root replies to y.
    await tx.update(postTable)
      .set({ replyTargetId: y.id })
      .where(eq(postTable.id, root.id));

    const page = await getDescendantPage(tx, root.id, {
      limit: 10,
      maxDepth: 20,
    });
    assert.deepEqual(page.entries.map((entry) => entry.id), [x.id, y.id]);
  });
});
