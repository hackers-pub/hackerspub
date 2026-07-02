import {
  arePostsBookmarkedBy,
  createBookmark,
} from "@hackerspub/models/bookmark";
import type { Transaction } from "@hackerspub/models/db";
import { follow } from "@hackerspub/models/following";
import { createOrganization } from "@hackerspub/models/organization";
import {
  accountTable,
  actorTable,
  articleDraftTable,
  followingTable,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7, type Uuid } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import assert from "node:assert";
import test from "node:test";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertReaction,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

async function follows(
  tx: Transaction,
  follower: { actor: { id: Uuid } },
  followee: { actor: { id: Uuid } },
) {
  await tx.insert(followingTable).values({
    iri:
      `https://example.com/following/${follower.actor.id}/${followee.actor.id}`,
    followerId: follower.actor.id,
    followeeId: followee.actor.id,
    accepted: new Date(),
  });
}

test("quotedPost does not leak a followers-only quoted post", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "vqauthor",
      name: "VQ Author",
      email: "vqauthor@example.com",
    });
    const follower = await insertAccountWithActor(tx, {
      username: "vqfollower",
      name: "VQ Follower",
      email: "vqfollower@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "vqstranger",
      name: "VQ Stranger",
      email: "vqstranger@example.com",
    });
    await follows(tx, follower, author);
    const { post: secret } = await insertNotePost(tx, {
      account: author.account,
      content: "SECRET quoted",
      visibility: "followers",
    });
    const { post: quoting } = await insertNotePost(tx, {
      account: author.account,
      content: "public quoting",
      quotedPostId: secret.id,
    });

    const query = parse(`
      query($id: ID!) {
        node(id: $id) { ... on Post { quotedPost { content } } }
      }
    `);
    const gid = encodeGlobalID("Note", quoting.id);
    interface Data {
      node: { quotedPost: { content: string } | null };
    }

    const strangerResult = await execute({
      schema,
      document: query,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, stranger.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(strangerResult.errors, undefined);
    assert.deepEqual(
      (strangerResult.data as unknown as Data).node.quotedPost,
      null,
    );

    const followerResult = await execute({
      schema,
      document: query,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, follower.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(followerResult.errors, undefined);
    assert.match(
      (followerResult.data as unknown as Data).node.quotedPost?.content ?? "",
      /SECRET/,
    );
  });
});

test("sharedPost does not leak a followers-only boosted post", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "vsauthor",
      name: "VS Author",
      email: "vsauthor@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "vsstranger",
      name: "VS Stranger",
      email: "vsstranger@example.com",
    });
    const { post: secret } = await insertNotePost(tx, {
      account: author.account,
      content: "SECRET boosted",
      visibility: "followers",
    });
    const { post: wrapper } = await insertNotePost(tx, {
      account: author.account,
      content: "",
      sharedPostId: secret.id,
    });

    const result = await execute({
      schema,
      document: parse(`
        query($id: ID!) {
          node(id: $id) { ... on Post { sharedPost { content } } }
        }
      `),
      variableValues: { id: encodeGlobalID("Note", wrapper.id) },
      contextValue: makeUserContext(tx, stranger.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as { node: { sharedPost: unknown } }).node.sharedPost,
      null,
    );
  });
});

test("quotes and shares connections exclude followers-only posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "vcauthor",
      name: "VC Author",
      email: "vcauthor@example.com",
    });
    const follower = await insertAccountWithActor(tx, {
      username: "vcfollower",
      name: "VC Follower",
      email: "vcfollower@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "vcstranger",
      name: "VC Stranger",
      email: "vcstranger@example.com",
    });
    await follows(tx, follower, author);
    const { post: pub } = await insertNotePost(tx, {
      account: author.account,
      content: "public target",
    });
    await insertNotePost(tx, {
      account: author.account,
      content: "SECRET quote of public",
      visibility: "followers",
      quotedPostId: pub.id,
    });
    await insertNotePost(tx, {
      account: author.account,
      content: "",
      visibility: "followers",
      sharedPostId: pub.id,
    });

    const query = parse(`
      query($id: ID!) {
        node(id: $id) {
          ... on Post {
            quotes { edges { node { content } } }
            shares { edges { node { id } } }
          }
        }
      }
    `);
    const gid = encodeGlobalID("Note", pub.id);
    interface Data {
      node: {
        quotes: { edges: { node: { content: string } }[] };
        shares: { edges: { node: { id: string } }[] };
      };
    }

    const strangerResult = await execute({
      schema,
      document: query,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, stranger.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(strangerResult.errors, undefined);
    const strangerData = strangerResult.data as unknown as Data;
    assert.deepEqual(strangerData.node.quotes.edges, []);
    assert.deepEqual(strangerData.node.shares.edges, []);

    const followerResult = await execute({
      schema,
      document: query,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, follower.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(followerResult.errors, undefined);
    const followerData = followerResult.data as unknown as Data;
    assert.equal(followerData.node.quotes.edges.length, 1);
    assert.match(followerData.node.quotes.edges[0].node.content, /SECRET/);
    assert.equal(followerData.node.shares.edges.length, 1);
  });
});

test("ArticleDraft node is not readable by a non-owner", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "draftowner",
      name: "Draft Owner",
      email: "draftowner@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "draftother",
      name: "Draft Other",
      email: "draftother@example.com",
    });
    const draftId = generateUuidV7();
    await tx.insert(articleDraftTable).values({
      id: draftId,
      accountId: owner.account.id,
      title: "Secret draft",
      content: "SECRET draft body",
      tags: [],
    });

    const query = parse(`
      query($id: ID!) {
        node(id: $id) { ... on ArticleDraft { title content } }
      }
    `);
    const gid = encodeGlobalID("ArticleDraft", draftId);
    interface Data {
      node: { title: string; content: string } | null;
    }

    const otherResult = await execute({
      schema,
      document: query,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, other.account),
      onError: "NO_PROPAGATE",
    });
    // Non-owner: unauthorized (node scope denies), no draft body returned.
    assert.ok((otherResult.errors?.length ?? 0) > 0);
    assert.equal((otherResult.data as unknown as Data)?.node, null);

    const guestResult = await execute({
      schema,
      document: query,
      variableValues: { id: gid },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.ok((guestResult.errors?.length ?? 0) > 0);

    const ownerResult = await execute({
      schema,
      document: query,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, owner.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(ownerResult.errors, undefined);
    assert.equal(
      (ownerResult.data as unknown as Data)?.node?.title,
      "Secret draft",
    );
  });
});

test("unbookmarkPost cannot be used to read an invisible post", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "ubauthor",
      name: "UB Author",
      email: "ubauthor@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "ubstranger",
      name: "UB Stranger",
      email: "ubstranger@example.com",
    });
    const { post: secret } = await insertNotePost(tx, {
      account: author.account,
      content: "SECRET unbookmark",
      visibility: "followers",
    });

    const result = await execute({
      schema,
      document: parse(`
        mutation($postId: ID!) {
          unbookmarkPost(input: { postId: $postId }) {
            __typename
            ... on UnbookmarkPostPayload { post { content } }
            ... on InvalidInputError { inputPath }
          }
        }
      `),
      variableValues: { postId: encodeGlobalID("Note", secret.id) },
      contextValue: makeUserContext(tx, stranger.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const payload = (result.data as {
      unbookmarkPost: { __typename: string };
    }).unbookmarkPost;
    assert.equal(payload.__typename, "InvalidInputError");
  });
});

test("reactor list excludes sanction-hidden actors", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "rxauthor",
      name: "RX Author",
      email: "rxauthor@example.com",
    });
    const goodReactor = await insertAccountWithActor(tx, {
      username: "rxgood",
      name: "RX Good",
      email: "rxgood@example.com",
    });
    const bannedReactor = await insertAccountWithActor(tx, {
      username: "rxbanned",
      name: "RX Banned",
      email: "rxbanned@example.com",
    });
    const viewer = await insertAccountWithActor(tx, {
      username: "rxviewer",
      name: "RX Viewer",
      email: "rxviewer@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "react to me",
      reactionsCounts: { "❤️": 2 },
    });
    await insertReaction(tx, {
      postId: post.id,
      actorId: goodReactor.actor.id,
    });
    await insertReaction(tx, {
      postId: post.id,
      actorId: bannedReactor.actor.id,
    });
    // Ban the reactor (permanent local suspension → sanction-hidden).
    await tx.update(actorTable)
      .set({ suspended: new Date(Date.now() - 1000), suspendedUntil: null })
      .where(eq(actorTable.id, bannedReactor.actor.id));

    const result = await execute({
      schema,
      document: parse(`
        query($id: ID!) {
          node(id: $id) {
            ... on Post {
              reactionGroups {
                reactors { totalCount edges { node { username } } }
              }
            }
          }
        }
      `),
      variableValues: { id: encodeGlobalID("Note", post.id) },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const groups = (result.data as {
      node: {
        reactionGroups: {
          reactors: {
            totalCount: number;
            edges: { node: { username: string } }[];
          };
        }[];
      };
    }).node.reactionGroups;
    const reactorNames = groups.flatMap((g) =>
      g.reactors.edges.map((e) => e.node.username)
    );
    assert.ok(reactorNames.includes("rxgood"));
    assert.ok(!reactorNames.includes("rxbanned"));
    // The total must exclude the banned reactor too, so it matches the
    // visible edges rather than the denormalized counter (which still counts
    // them).
    const total = groups.reduce((sum, g) => sum + g.reactors.totalCount, 0);
    assert.equal(total, 1);
  });
});

test("unbookmarkPost lets the owner remove a bookmark on a now-invisible post", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "ubowner_author",
      name: "UB Owner Author",
      email: "ubowner_author@example.com",
    });
    const viewer = await insertAccountWithActor(tx, {
      username: "ubowner_viewer",
      name: "UB Owner Viewer",
      email: "ubowner_viewer@example.com",
    });
    // The viewer bookmarks a public post, then the post is downgraded to
    // followers-only (and the viewer does not follow the author), so it is no
    // longer visible to them.
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "was public",
    });
    await createBookmark(tx, viewer.account, post);
    await tx.update(postTable)
      .set({ visibility: "followers" })
      .where(eq(postTable.id, post.id));

    const result = await execute({
      schema,
      document: parse(`
        mutation($postId: ID!) {
          unbookmarkPost(input: { postId: $postId }) {
            __typename
            ... on UnbookmarkPostPayload {
              unbookmarkedPostId
              post { id }
            }
            ... on InvalidInputError { inputPath }
          }
        }
      `),
      variableValues: { postId: encodeGlobalID("Note", post.id) },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const payload = (result.data as {
      unbookmarkPost: { __typename: string; post: { id: string } | null };
    }).unbookmarkPost;
    assert.equal(payload.__typename, "UnbookmarkPostPayload");
    // Removal succeeds, but the payload does not re-expose the now-invisible
    // post's content.
    assert.equal(payload.post, null);
    // The bookmark is actually gone.
    assert.deepEqual(
      await arePostsBookmarkedBy(tx, [post.id], viewer.account),
      new Set(),
    );
  });
});

test("Post.replies applies the acting account's visibility, not the personal one", async () => {
  await withRollback(async (tx) => {
    const member = await insertAccountWithActor(tx, {
      username: "orgrepliesmember",
      name: "Org Replies Member",
      email: "orgrepliesmember@example.com",
    });
    const author = await insertAccountWithActor(tx, {
      username: "orgrepliesauthor",
      name: "Org Replies Author",
      email: "orgrepliesauthor@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, member.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      member.account,
      {
        username: "orgreplies",
        name: "Org Replies",
        bio: "",
      },
    );
    // The organization (not the member's personal actor) follows the author.
    await follow(createFedCtx(tx), organization, author.actor);

    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "public root",
    });
    const { post: reply } = await insertNotePost(tx, {
      account: author.account,
      content: "followers-only reply",
      visibility: "followers",
      replyTargetId: root.id,
    });

    const query = parse(`
      query($id: ID!, $actingAccountId: ID) {
        node(id: $id) {
          ... on Post {
            replies(actingAccountId: $actingAccountId) {
              edges { node { id } }
            }
          }
        }
      }
    `);
    const gid = encodeGlobalID("Note", root.id);
    interface Data {
      node: { replies: { edges: { node: { id: string } }[] } };
    }

    // Personal perspective: the member does not follow the author, so the
    // followers-only reply is hidden.
    const personal = await execute({
      schema,
      document: query,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, member.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(personal.errors, undefined);
    assert.deepEqual(
      (personal.data as unknown as Data).node.replies.edges,
      [],
    );

    // Organization perspective: the org follows the author, so the reply is
    // visible.
    const org = await execute({
      schema,
      document: query,
      variableValues: {
        id: gid,
        actingAccountId: encodeGlobalID("Account", organization.id),
      },
      contextValue: makeUserContext(tx, member.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(org.errors, undefined);
    assert.deepEqual(
      (org.data as unknown as Data).node.replies.edges.map((e) => e.node.id),
      [encodeGlobalID("Note", reply.id)],
    );
  });
});

test("Post.replies.totalCount counts only visible replies", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "rtcauthor",
      name: "RTC Author",
      email: "rtcauthor@example.com",
    });
    const follower = await insertAccountWithActor(tx, {
      username: "rtcfollower",
      name: "RTC Follower",
      email: "rtcfollower@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "rtcstranger",
      name: "RTC Stranger",
      email: "rtcstranger@example.com",
    });
    await follows(tx, follower, author);
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
    });
    await insertNotePost(tx, {
      account: author.account,
      content: "public reply",
      replyTargetId: root.id,
    });
    await insertNotePost(tx, {
      account: author.account,
      content: "followers-only reply",
      visibility: "followers",
      replyTargetId: root.id,
    });

    const query = parse(`
      query($id: ID!) {
        node(id: $id) { ... on Post { replies(first: 0) { totalCount } } }
      }
    `);
    const gid = encodeGlobalID("Note", root.id);
    interface Data {
      node: { replies: { totalCount: number } };
    }

    const asStranger = await execute({
      schema,
      document: query,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, stranger.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(asStranger.errors, undefined);
    // The stranger sees only the public reply, not the followers-only one.
    assert.equal(
      (asStranger.data as unknown as Data).node.replies.totalCount,
      1,
    );

    const asFollower = await execute({
      schema,
      document: query,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, follower.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(asFollower.errors, undefined);
    assert.equal(
      (asFollower.data as unknown as Data).node.replies.totalCount,
      2,
    );
  });
});

test("descendants hydrate note sources so own replies stay editable", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "editauthor",
      name: "Edit Author",
      email: "editauthor@example.com",
    });
    const { post: root } = await insertNotePost(tx, {
      account: author.account,
      content: "root",
    });
    await insertNotePost(tx, {
      account: author.account,
      content: "editable reply body",
      replyTargetId: root.id,
    });

    const query = parse(`
      query($id: ID!) {
        node(id: $id) {
          ... on Post {
            descendants(first: 10) {
              edges { node { ... on Note { rawContent } } }
            }
          }
        }
      }
    `);
    interface Data {
      node: {
        descendants: { edges: { node: { rawContent: string | null } }[] };
      };
    }

    const result = await execute({
      schema,
      document: query,
      variableValues: { id: encodeGlobalID("Note", root.id) },
      contextValue: makeUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const edges = (result.data as unknown as Data).node.descendants.edges;
    assert.equal(edges.length, 1);
    // The author owns the reply, so its Markdown source must resolve; before
    // the loader hydrated `noteSource` this came back `null` and the client
    // hid the edit action.
    assert.equal(edges[0].node.rawContent, "editable reply body");
  });
});
