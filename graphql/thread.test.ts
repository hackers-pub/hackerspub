import { followingTable, postTable } from "@hackerspub/models/schema";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import assert from "node:assert";
import test from "node:test";
import {
  insertAccountWithActor,
  insertNotePost,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";
import { schema } from "./mod.ts";

const ancestorsQuery = parse(`
  query Ancestors($id: ID!) {
    node(id: $id) {
      ... on Post {
        ancestors {
          edges {
            node {
              id
              replyTarget { id }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }
  }
`);

const descendantsQuery = parse(`
  query Descendants($id: ID!, $first: Int, $after: String, $maxDepth: Int) {
    node(id: $id) {
      ... on Post {
        descendants(first: $first, after: $after, maxDepth: $maxDepth) {
          edges {
            cursor
            node {
              id
              replyTarget { id }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`);

interface ThreadConnectionData {
  node: {
    ancestors?: {
      edges: { node: { id: string; replyTarget: { id: string } | null } }[];
      pageInfo: { hasNextPage: boolean };
    };
    descendants?: {
      edges: {
        cursor: string;
        node: { id: string; replyTarget: { id: string } | null };
      }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

test("Post.ancestors returns the visible chain nearest-first", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "gqlancestors",
      name: "GQL Ancestors",
      email: "gqlancestors@example.com",
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

    const result = await execute({
      schema,
      document: ancestorsQuery,
      variableValues: { id: encodeGlobalID("Note", leaf.id) },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const { ancestors } = (result.data as unknown as ThreadConnectionData)
      .node;
    assert.deepEqual(
      ancestors?.edges.map((edge) => edge.node.id),
      [encodeGlobalID("Note", middle.id), encodeGlobalID("Note", root.id)],
    );
    // No gap: each node's replyTarget is the next node in the chain.
    assert.deepEqual(
      ancestors?.edges[0].node.replyTarget?.id,
      encodeGlobalID("Note", root.id),
    );
    assert.deepEqual(ancestors?.edges[1].node.replyTarget, null);
    assert.deepEqual(ancestors?.pageInfo.hasNextPage, false);
  });
});

test("Post.ancestors omits invisible ancestors but keeps the chain above", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "gqlancestorsgap",
      name: "GQL Ancestors Gap",
      email: "gqlancestorsgap@example.com",
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
    const { post: leaf } = await insertNotePost(tx, {
      account: author.account,
      content: "leaf",
      replyTargetId: censored.id,
    });
    await tx.update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, censored.id));

    const result = await execute({
      schema,
      document: ancestorsQuery,
      variableValues: { id: encodeGlobalID("Note", leaf.id) },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const { ancestors } = (result.data as unknown as ThreadConnectionData)
      .node;
    // The censored middle ancestor is omitted; the root is still returned,
    // and the gap is detectable: the leaf's nearest returned ancestor is
    // the root, but the leaf's replyTarget is not the root.
    assert.deepEqual(
      ancestors?.edges.map((edge) => edge.node.id),
      [encodeGlobalID("Note", root.id)],
    );
  });
});

test("Post.descendants flattens the subtree depth-first with parent links", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "gqldescendants",
      name: "GQL Descendants",
      email: "gqldescendants@example.com",
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

    const result = await execute({
      schema,
      document: descendantsQuery,
      variableValues: { id: encodeGlobalID("Note", root.id) },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const { descendants } = (result.data as unknown as ThreadConnectionData)
      .node;
    assert.deepEqual(
      descendants?.edges.map((edge) => [
        edge.node.id,
        edge.node.replyTarget?.id,
      ]),
      [
        [encodeGlobalID("Note", r1.id), encodeGlobalID("Note", root.id)],
        [encodeGlobalID("Note", r1a.id), encodeGlobalID("Note", r1.id)],
        [encodeGlobalID("Note", r2.id), encodeGlobalID("Note", root.id)],
      ],
    );
    assert.deepEqual(descendants?.pageInfo.hasNextPage, false);
  });
});

test("Post.descendants paginates across subtree boundaries", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "gqldescpage",
      name: "GQL Desc Page",
      email: "gqldescpage@example.com",
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

    const first = await execute({
      schema,
      document: descendantsQuery,
      variableValues: { id: encodeGlobalID("Note", root.id), first: 2 },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(first.errors, undefined);
    const page1 = (first.data as unknown as ThreadConnectionData).node
      .descendants;
    assert.deepEqual(
      page1?.edges.map((edge) => edge.node.id),
      [encodeGlobalID("Note", r1.id), encodeGlobalID("Note", r1a.id)],
    );
    assert.deepEqual(page1?.pageInfo.hasNextPage, true);

    const second = await execute({
      schema,
      document: descendantsQuery,
      variableValues: {
        id: encodeGlobalID("Note", root.id),
        first: 2,
        after: page1?.pageInfo.endCursor,
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(second.errors, undefined);
    const page2 = (second.data as unknown as ThreadConnectionData).node
      .descendants;
    assert.deepEqual(
      page2?.edges.map((edge) => edge.node.id),
      [encodeGlobalID("Note", r2.id)],
    );
    assert.deepEqual(page2?.pageInfo.hasNextPage, false);
  });
});

test("Post.descendants respects maxDepth", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "gqldescdepth",
      name: "GQL Desc Depth",
      email: "gqldescdepth@example.com",
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

    const result = await execute({
      schema,
      document: descendantsQuery,
      variableValues: { id: encodeGlobalID("Note", root.id), maxDepth: 1 },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const { descendants } = (result.data as unknown as ThreadConnectionData)
      .node;
    assert.deepEqual(
      descendants?.edges.map((edge) => edge.node.id),
      [encodeGlobalID("Note", child.id)],
    );
  });
});

test("Post.descendants prunes censored subtrees, except for the author", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "gqldesccensor",
      name: "GQL Desc Censor",
      email: "gqldesccensor@example.com",
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
    await insertNotePost(tx, {
      account: author.account,
      content: "buried",
      replyTargetId: censored.id,
    });
    await tx.update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, censored.id));

    const guest = await execute({
      schema,
      document: descendantsQuery,
      variableValues: { id: encodeGlobalID("Note", root.id) },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(guest.errors, undefined);
    assert.deepEqual(
      (guest.data as unknown as ThreadConnectionData).node.descendants?.edges,
      [],
    );

    const own = await execute({
      schema,
      document: descendantsQuery,
      variableValues: { id: encodeGlobalID("Note", root.id) },
      contextValue: makeUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(own.errors, undefined);
    assert.deepEqual(
      (own.data as unknown as ThreadConnectionData).node.descendants?.edges
        .length,
      2,
    );
  });
});

test("followers-only replies are hidden from non-followers in threads", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "gqlthreadfollowee",
      name: "GQL Thread Followee",
      email: "gqlthreadfollowee@example.com",
    });
    const follower = await insertAccountWithActor(tx, {
      username: "gqlthreadfollower",
      name: "GQL Thread Follower",
      email: "gqlthreadfollower@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "gqlthreadstranger",
      name: "GQL Thread Stranger",
      email: "gqlthreadstranger@example.com",
    });
    await tx.insert(followingTable).values({
      iri:
        `https://example.com/following/${follower.actor.id}/${author.actor.id}`,
      followerId: follower.actor.id,
      followeeId: author.actor.id,
      accepted: new Date(),
    });
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
    });
    const { post: hidden } = await insertNotePost(tx, {
      account: author.account,
      content: "followers only",
      replyTargetId: root.id,
      visibility: "followers",
    });
    const { post: leaf } = await insertNotePost(tx, {
      account: author.account,
      content: "leaf",
      replyTargetId: hidden.id,
    });

    const repliesQuery = parse(`
      query Replies($id: ID!) {
        node(id: $id) {
          ... on Post {
            replies { edges { node { id } } }
            descendants { edges { node { id } } }
          }
        }
      }
    `);
    interface RepliesData {
      node: {
        replies: { edges: { node: { id: string } }[] };
        descendants: { edges: { node: { id: string } }[] };
      };
    }

    // A stranger sees neither the followers-only reply nor its subtree.
    const strangerResult = await execute({
      schema,
      document: repliesQuery,
      variableValues: { id: encodeGlobalID("Note", root.id) },
      contextValue: makeUserContext(tx, stranger.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(strangerResult.errors, undefined);
    const strangerData = strangerResult.data as unknown as RepliesData;
    assert.deepEqual(strangerData.node.replies.edges, []);
    assert.deepEqual(strangerData.node.descendants.edges, []);

    // A follower sees the whole subtree.
    const followerResult = await execute({
      schema,
      document: repliesQuery,
      variableValues: { id: encodeGlobalID("Note", root.id) },
      contextValue: makeUserContext(tx, follower.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(followerResult.errors, undefined);
    const followerData = followerResult.data as unknown as RepliesData;
    assert.deepEqual(
      followerData.node.replies.edges.map((edge) => edge.node.id),
      [encodeGlobalID("Note", hidden.id)],
    );
    assert.deepEqual(
      followerData.node.descendants.edges.map((edge) => edge.node.id),
      [encodeGlobalID("Note", hidden.id), encodeGlobalID("Note", leaf.id)],
    );

    // The ancestor chain of the buried leaf also hides the followers-only
    // post from the stranger while keeping the root.
    const strangerAncestors = await execute({
      schema,
      document: ancestorsQuery,
      variableValues: { id: encodeGlobalID("Note", leaf.id) },
      contextValue: makeUserContext(tx, stranger.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(strangerAncestors.errors, undefined);
    assert.deepEqual(
      (strangerAncestors.data as unknown as ThreadConnectionData).node
        .ancestors?.edges.map((edge) => edge.node.id),
      [encodeGlobalID("Note", root.id)],
    );

    // Post.replyTarget must not leak the followers-only parent either.
    const replyTargetQuery = parse(`
      query ReplyTarget($id: ID!) {
        node(id: $id) {
          ... on Post {
            replyTarget { id }
          }
        }
      }
    `);
    interface ReplyTargetData {
      node: { replyTarget: { id: string } | null };
    }
    const strangerParent = await execute({
      schema,
      document: replyTargetQuery,
      variableValues: { id: encodeGlobalID("Note", leaf.id) },
      contextValue: makeUserContext(tx, stranger.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(strangerParent.errors, undefined);
    assert.deepEqual(
      (strangerParent.data as unknown as ReplyTargetData).node.replyTarget,
      null,
    );
    const followerParent = await execute({
      schema,
      document: replyTargetQuery,
      variableValues: { id: encodeGlobalID("Note", leaf.id) },
      contextValue: makeUserContext(tx, follower.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(followerParent.errors, undefined);
    assert.deepEqual(
      (followerParent.data as unknown as ReplyTargetData).node.replyTarget
        ?.id,
      encodeGlobalID("Note", hidden.id),
    );
  });
});

test("Post.descendants rejects malformed cursors and backward pagination", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "gqldesccursor",
      name: "GQL Desc Cursor",
      email: "gqldesccursor@example.com",
    });
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
    });

    const malformed = await execute({
      schema,
      document: descendantsQuery,
      variableValues: {
        id: encodeGlobalID("Note", root.id),
        after: btoa("nonsense"),
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(malformed.errors?.length, 1);
    assert.match(malformed.errors![0].message, /[Mm]alformed/);

    const backward = await execute({
      schema,
      document: parse(`
        query Backward($id: ID!) {
          node(id: $id) {
            ... on Post {
              descendants(last: 5) { edges { node { id } } }
            }
          }
        }
      `),
      variableValues: { id: encodeGlobalID("Note", root.id) },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(backward.errors?.length, 1);
    assert.match(backward.errors![0].message, /forward pagination/);
  });
});
