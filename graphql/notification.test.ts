import assert from "node:assert";
import test from "node:test";
import {
  accountTable,
  type Actor as ActorRow,
  actorTable,
  notificationTable,
} from "@hackerspub/models/schema";
import { generateUuidV7, type Uuid } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import DataLoader from "dataloader";
import { eq, inArray, sql } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const notificationActorsQuery = parse(`
  query NotificationActorsOrderQuery {
    viewer {
      notifications(first: 10) {
        edges {
          node {
            ... on FollowNotification {
              actors(first: 10) {
                edges {
                  node {
                    id
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`);

const postUpdatedNotificationTypesQuery = parse(`
  query PostUpdatedNotificationTypesQuery {
    viewer {
      notifications(first: 10) {
        edges {
          node {
            __typename
            ... on SharedPostUpdatedNotification {
              post {
                uuid
              }
            }
            ... on QuotedPostUpdatedNotification {
              post {
                uuid
              }
            }
            ... on PollEndedNotification {
              post {
                uuid
              }
            }
          }
        }
      }
    }
  }
`);

const unreadNotificationsCountQuery = parse(`
  query UnreadNotificationsCountQuery {
    viewer {
      unreadNotificationsCount
    }
  }
`);

const markNotificationsAsReadMutation = parse(`
  mutation MarkNotificationsAsRead($upTo: UUID) {
    markNotificationsAsRead(upTo: $upTo)
  }
`);

test(
  "Account.unreadNotificationsCount counts notifications newer than notificationRead",
  async () => {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "notifycountme",
        name: "Notify Count Me",
        email: "notifycountme@example.com",
      });
      const actor = await insertAccountWithActor(tx, {
        username: "notifycountactor",
        name: "Notify Count Actor",
        email: "notifycountactor@example.com",
      });
      const otherActor = await insertAccountWithActor(tx, {
        username: "notifycountother",
        name: "Notify Count Other",
        email: "notifycountother@example.com",
      });

      await tx.update(accountTable)
        .set({ notificationRead: new Date("2026-04-15T00:00:01.000Z") })
        .where(eq(accountTable.id, recipient.account.id));
      await tx.insert(notificationTable).values([
        {
          id: generateUuidV7(),
          accountId: recipient.account.id,
          type: "follow",
          actorIds: [actor.actor.id],
          created: new Date("2026-04-15T00:00:00.000Z"),
        },
        {
          id: generateUuidV7(),
          accountId: recipient.account.id,
          type: "follow",
          actorIds: [otherActor.actor.id],
          created: new Date("2026-04-15T00:00:02.000Z"),
        },
      ]);

      const result = await execute({
        schema,
        document: unreadNotificationsCountQuery,
        contextValue: makeUserContext(tx, recipient.account),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(result.errors, undefined);
      assert.deepEqual(result.data, {
        viewer: {
          unreadNotificationsCount: 1,
        },
      });
    });
  },
);

test(
  "Account.unreadNotificationsCount counts all notifications when never read",
  async () => {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "notifyallme",
        name: "Notify All Me",
        email: "notifyallme@example.com",
      });
      const actor = await insertAccountWithActor(tx, {
        username: "notifyallactor",
        name: "Notify All Actor",
        email: "notifyallactor@example.com",
      });
      const otherActor = await insertAccountWithActor(tx, {
        username: "notifyallother",
        name: "Notify All Other",
        email: "notifyallother@example.com",
      });

      await tx.insert(notificationTable).values([
        {
          id: generateUuidV7(),
          accountId: recipient.account.id,
          type: "follow",
          actorIds: [actor.actor.id],
          created: new Date("2026-04-15T00:00:00.000Z"),
        },
        {
          id: generateUuidV7(),
          accountId: recipient.account.id,
          type: "follow",
          actorIds: [otherActor.actor.id],
          created: new Date("2026-04-15T00:00:01.000Z"),
        },
      ]);

      const result = await execute({
        schema,
        document: unreadNotificationsCountQuery,
        contextValue: makeUserContext(tx, recipient.account),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(result.errors, undefined);
      assert.deepEqual(result.data, {
        viewer: {
          unreadNotificationsCount: 2,
        },
      });
    });
  },
);

test("Notification exposes post-backed notification concrete types", async () => {
  await withRollback(async (tx) => {
    const recipient = await insertAccountWithActor(tx, {
      username: "notifypostupdatedme",
      name: "Notify Post Updated Me",
      email: "notifypostupdatedme@example.com",
    });
    const actor = await insertAccountWithActor(tx, {
      username: "notifypostupdatedactor",
      name: "Notify Post Updated Actor",
      email: "notifypostupdatedactor@example.com",
    });
    const { post: sharedPost } = await insertNotePost(tx, {
      account: actor.account,
      content: "Shared post that later changed",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: actor.account,
      content: "Quoted post that later changed",
    });
    const { post: endedPollPost } = await insertNotePost(tx, {
      account: actor.account,
      content: "Poll that ended",
    });

    await tx.insert(notificationTable).values([
      {
        id: generateUuidV7(),
        accountId: recipient.account.id,
        type: "poll_ended",
        postId: endedPollPost.id,
        actorIds: [actor.actor.id],
        created: new Date("2026-04-15T00:00:02.000Z"),
      },
      {
        id: generateUuidV7(),
        accountId: recipient.account.id,
        type: "shared_post_updated",
        postId: sharedPost.id,
        actorIds: [actor.actor.id],
        created: new Date("2026-04-15T00:00:01.000Z"),
      },
      {
        id: generateUuidV7(),
        accountId: recipient.account.id,
        type: "quoted_post_updated",
        postId: quotedPost.id,
        actorIds: [actor.actor.id],
        created: new Date("2026-04-15T00:00:00.000Z"),
      },
    ]);

    const result = await execute({
      schema,
      document: postUpdatedNotificationTypesQuery,
      contextValue: makeUserContext(tx, recipient.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(result.data, {
      viewer: {
        notifications: {
          edges: [
            {
              node: {
                __typename: "PollEndedNotification",
                post: { uuid: endedPollPost.id },
              },
            },
            {
              node: {
                __typename: "SharedPostUpdatedNotification",
                post: { uuid: sharedPost.id },
              },
            },
            {
              node: {
                __typename: "QuotedPostUpdatedNotification",
                post: { uuid: quotedPost.id },
              },
            },
          ],
        },
      },
    });
  });
});

test(
  "markNotificationsAsRead respects the optional upTo notification",
  async () => {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "notifymarkme",
        name: "Notify Mark Me",
        email: "notifymarkme@example.com",
      });
      const actor = await insertAccountWithActor(tx, {
        username: "notifymarkactor",
        name: "Notify Mark Actor",
        email: "notifymarkactor@example.com",
      });
      const otherActor = await insertAccountWithActor(tx, {
        username: "notifymarkother",
        name: "Notify Mark Other",
        email: "notifymarkother@example.com",
      });
      const olderNotificationId = generateUuidV7();
      const newerNotificationId = generateUuidV7();

      await tx.insert(notificationTable).values([
        {
          id: olderNotificationId,
          accountId: recipient.account.id,
          type: "follow",
          actorIds: [actor.actor.id],
          created: new Date("2026-04-15T00:00:00.000Z"),
        },
        {
          id: newerNotificationId,
          accountId: recipient.account.id,
          type: "follow",
          actorIds: [otherActor.actor.id],
          created: new Date("2026-04-15T00:00:02.000Z"),
        },
      ]);

      const markResult = await execute({
        schema,
        document: markNotificationsAsReadMutation,
        variableValues: { upTo: olderNotificationId },
        contextValue: makeUserContext(tx, recipient.account),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(markResult.errors, undefined);

      const countResult = await execute({
        schema,
        document: unreadNotificationsCountQuery,
        contextValue: makeUserContext(tx, recipient.account),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(countResult.errors, undefined);
      assert.deepEqual(countResult.data, {
        viewer: {
          unreadNotificationsCount: 1,
        },
      });
    });
  },
);

test(
  "markNotificationsAsRead preserves database timestamp precision",
  async () => {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "notifyprecisionme",
        name: "Notify Precision Me",
        email: "notifyprecisionme@example.com",
      });
      const actor = await insertAccountWithActor(tx, {
        username: "notifyprecisionactor",
        name: "Notify Precision Actor",
        email: "notifyprecisionactor@example.com",
      });
      const notificationId = generateUuidV7();

      await tx.insert(notificationTable).values({
        id: notificationId,
        accountId: recipient.account.id,
        type: "follow",
        actorIds: [actor.actor.id],
        created: new Date("2026-04-15T00:00:00.000Z"),
      });
      await tx.update(notificationTable)
        .set({
          created: sql`'2026-04-15T00:00:00.123456Z'::timestamptz`,
        })
        .where(eq(notificationTable.id, notificationId));

      const markResult = await execute({
        schema,
        document: markNotificationsAsReadMutation,
        variableValues: { upTo: notificationId },
        contextValue: makeUserContext(tx, recipient.account),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(markResult.errors, undefined);

      const countResult = await execute({
        schema,
        document: unreadNotificationsCountQuery,
        contextValue: makeUserContext(tx, recipient.account),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(countResult.errors, undefined);
      assert.deepEqual(countResult.data, {
        viewer: {
          unreadNotificationsCount: 0,
        },
      });
    });
  },
);

test("Notification.actors returns actors newest-first", async () => {
  await withRollback(async (tx) => {
    const recipient = await insertAccountWithActor(tx, {
      username: "notifyme",
      name: "Notify Me",
      email: "notifyme@example.com",
    });
    const olderActor = await insertAccountWithActor(tx, {
      username: "olderactor",
      name: "Older Actor",
      email: "olderactor@example.com",
    });
    const newerActor = await insertAccountWithActor(tx, {
      username: "neweractor",
      name: "Newer Actor",
      email: "neweractor@example.com",
    });

    await tx.insert(notificationTable).values({
      id: crypto.randomUUID(),
      accountId: recipient.account.id,
      type: "follow",
      actorIds: [olderActor.actor.id, newerActor.actor.id],
      created: new Date("2026-04-15T00:00:00.000Z"),
    });

    const result = await execute({
      schema,
      document: notificationActorsQuery,
      contextValue: makeUserContext(tx, recipient.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);

    const data = result.data as {
      viewer: {
        notifications: {
          edges: {
            node: {
              actors: {
                edges: { node: { id: string } }[];
              };
            };
          }[];
        };
      } | null;
    };

    const edges = data.viewer?.notifications.edges;
    assert.ok(edges != null && edges.length > 0);
    assert.deepEqual(
      edges[0].node.actors.edges.map((edge) => edge.node.id),
      [
        encodeGlobalID("Actor", newerActor.actor.id),
        encodeGlobalID("Actor", olderActor.actor.id),
      ],
    );
  });
});

test(
  "Notification.actors batches across multiple notifications",
  async () => {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "notifybatchme",
        name: "Notify Batch Me",
        email: "notifybatchme@example.com",
      });
      const actorA = await insertAccountWithActor(tx, {
        username: "notifybatchactora",
        name: "Notify Batch Actor A",
        email: "notifybatchactora@example.com",
      });
      const actorB = await insertAccountWithActor(tx, {
        username: "notifybatchactorb",
        name: "Notify Batch Actor B",
        email: "notifybatchactorb@example.com",
      });
      const actorC = await insertAccountWithActor(tx, {
        username: "notifybatchactorc",
        name: "Notify Batch Actor C",
        email: "notifybatchactorc@example.com",
      });

      // Two notifications for the same recipient.  actorB appears in
      // both — exercising the per-request DataLoader cache path that
      // dedupes overlapping ids across notifications.
      await tx.insert(notificationTable).values([
        {
          id: generateUuidV7(),
          accountId: recipient.account.id,
          type: "follow",
          actorIds: [actorA.actor.id, actorB.actor.id],
          // Newer notification — surfaces first via desc(created).
          created: new Date("2026-04-15T00:00:01.000Z"),
        },
        {
          id: generateUuidV7(),
          accountId: recipient.account.id,
          type: "follow",
          actorIds: [actorB.actor.id, actorC.actor.id],
          created: new Date("2026-04-15T00:00:00.000Z"),
        },
      ]);

      const result = await execute({
        schema,
        document: notificationActorsQuery,
        contextValue: makeUserContext(tx, recipient.account),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(result.errors, undefined);

      const data = result.data as {
        viewer: {
          notifications: {
            edges: {
              node: {
                actors: {
                  edges: { node: { id: string } }[];
                };
              };
            }[];
          };
        } | null;
      };

      const edges = data.viewer?.notifications.edges;
      assert.ok(edges != null);
      assert.deepEqual(edges.length, 2);

      // Each notification still resolves to its own ordered actor list,
      // newest-position-first (the resolver's existing semantics).
      assert.deepEqual(
        edges[0].node.actors.edges.map((edge) => edge.node.id),
        [
          encodeGlobalID("Actor", actorB.actor.id),
          encodeGlobalID("Actor", actorA.actor.id),
        ],
      );
      assert.deepEqual(
        edges[1].node.actors.edges.map((edge) => edge.node.id),
        [
          encodeGlobalID("Actor", actorC.actor.id),
          encodeGlobalID("Actor", actorB.actor.id),
        ],
      );
    });
  },
);

test(
  "Notification.actors filters out missing actor ids without breaking the batch",
  async () => {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "notifymissingme",
        name: "Notify Missing Me",
        email: "notifymissingme@example.com",
      });
      const realActor = await insertAccountWithActor(tx, {
        username: "notifymissingreal",
        name: "Notify Missing Real",
        email: "notifymissingreal@example.com",
      });
      const phantomId = generateUuidV7();

      await tx.insert(notificationTable).values({
        id: generateUuidV7(),
        accountId: recipient.account.id,
        type: "follow",
        actorIds: [phantomId, realActor.actor.id],
        created: new Date("2026-04-15T00:00:00.000Z"),
      });

      const result = await execute({
        schema,
        document: notificationActorsQuery,
        contextValue: makeUserContext(tx, recipient.account),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(result.errors, undefined);
      const data = result.data as {
        viewer: {
          notifications: {
            edges: {
              node: { actors: { edges: { node: { id: string } }[] } };
            }[];
          };
        } | null;
      };

      const edges = data.viewer?.notifications.edges;
      assert.ok(edges != null && edges.length === 1);
      assert.deepEqual(
        edges[0].node.actors.edges.map((edge) => edge.node.id),
        [encodeGlobalID("Actor", realActor.actor.id)],
      );
    });
  },
);

test(
  "Notification.actors fires one DataLoader batch for the deduped actor id union",
  async () => {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "notifyspyme",
        name: "Notify Spy Me",
        email: "notifyspyme@example.com",
      });
      const actorA = await insertAccountWithActor(tx, {
        username: "notifyspyactora",
        name: "Notify Spy Actor A",
        email: "notifyspyactora@example.com",
      });
      const actorB = await insertAccountWithActor(tx, {
        username: "notifyspyactorb",
        name: "Notify Spy Actor B",
        email: "notifyspyactorb@example.com",
      });
      const actorC = await insertAccountWithActor(tx, {
        username: "notifyspyactorc",
        name: "Notify Spy Actor C",
        email: "notifyspyactorc@example.com",
      });

      // Two notifications with overlapping actor ids — actorB appears
      // in both.  After dedupe, the loader should batch exactly the
      // three distinct ids in a single call.
      await tx.insert(notificationTable).values([
        {
          id: generateUuidV7(),
          accountId: recipient.account.id,
          type: "follow",
          actorIds: [actorA.actor.id, actorB.actor.id],
          created: new Date("2026-04-15T00:00:01.000Z"),
        },
        {
          id: generateUuidV7(),
          accountId: recipient.account.id,
          type: "follow",
          actorIds: [actorB.actor.id, actorC.actor.id],
          created: new Date("2026-04-15T00:00:00.000Z"),
        },
      ]);

      const batches: Uuid[][] = [];
      const actorByIdLoader = new DataLoader<Uuid, ActorRow | null>(
        async (ids) => {
          const idList = ids as Uuid[];
          batches.push([...idList]);
          const rows = await tx
            .select()
            .from(actorTable)
            .where(inArray(actorTable.id, idList));
          const byId = new Map(rows.map((row) => [row.id, row]));
          return idList.map((id) => byId.get(id) ?? null);
        },
      );

      const result = await execute({
        schema,
        document: notificationActorsQuery,
        contextValue: makeUserContext(tx, recipient.account, {
          actorByIdLoader,
        }),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(result.errors, undefined);

      // Exactly one batch — the loader collapsed both notifications'
      // actor lookups into one SQL query.
      assert.deepEqual(batches.length, 1);

      // The batch contains exactly the deduped union (3 ids) of every
      // actor id requested across both notifications, in some order.
      // The length check rules out an undeduped payload that happens
      // to contain the right Set.
      assert.deepEqual(batches[0].length, 3);
      assert.deepEqual(
        new Set(batches[0]),
        new Set([
          actorA.actor.id,
          actorB.actor.id,
          actorC.actor.id,
        ]),
      );
    });
  },
);

test(
  "Notification.actors deduplicates repeated actor ids within a notification",
  async () => {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "notifydedupeme",
        name: "Notify Dedupe Me",
        email: "notifydedupeme@example.com",
      });
      const actor = await insertAccountWithActor(tx, {
        username: "notifydedupeactor",
        name: "Notify Dedupe Actor",
        email: "notifydedupeactor@example.com",
      });

      // Bypass the createNotification merge logic and write a row with
      // a duplicated actorId directly, so we can verify the resolver
      // dedupes on read.  In production this is prevented at write
      // time, but the resolver still defends the parity.
      await tx.insert(notificationTable).values({
        id: generateUuidV7(),
        accountId: recipient.account.id,
        type: "follow",
        actorIds: [actor.actor.id, actor.actor.id],
        created: new Date("2026-04-15T00:00:00.000Z"),
      });

      const result = await execute({
        schema,
        document: notificationActorsQuery,
        contextValue: makeUserContext(tx, recipient.account),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(result.errors, undefined);
      const data = result.data as {
        viewer: {
          notifications: {
            edges: {
              node: { actors: { edges: { node: { id: string } }[] } };
            }[];
          };
        } | null;
      };

      const edges = data.viewer?.notifications.edges;
      assert.ok(edges != null && edges.length === 1);
      // Duplicate id in actorIds yields a single edge in the
      // connection, matching the prior findMany IN (…) semantics.
      assert.deepEqual(
        edges[0].node.actors.edges.map((edge) => edge.node.id),
        [encodeGlobalID("Actor", actor.actor.id)],
      );
    });
  },
);
