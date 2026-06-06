import assert from "node:assert";
import test from "node:test";
import { INVITATIONS_LAST_REGEN_KEY } from "@hackerspub/models/admin";
import { accountTable, mediumTable } from "@hackerspub/models/schema";
import { generateUuidV7, type Uuid } from "@hackerspub/models/uuid";
import { eq, inArray, sql } from "drizzle-orm";
import { execute, parse } from "graphql";
import type { UserContext } from "./builder.ts";
import { schema } from "./mod.ts";
import {
  createTestKv,
  insertAccountWithActor,
  insertNotePost,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

function createTrackingDisk() {
  const deleteKeys: string[] = [];
  return {
    deleteKeys,
    disk: {
      delete(key: string) {
        deleteKeys.push(key);
        return Promise.resolve(undefined);
      },
    } as unknown as UserContext["disk"],
  };
}

async function insertTestMedium(
  tx: Parameters<Parameters<typeof withRollback>[0]>[0],
  key: string,
  created: Date,
): Promise<Uuid> {
  const id = generateUuidV7();
  await tx.insert(mediumTable).values({
    id,
    key,
    type: "image/webp",
    contentHash: null,
    width: 1,
    height: 1,
    created,
  });
  return id;
}

const adminAccountsQuery = parse(`
  query AdminAccounts(
    $first: Int
    $after: String
    $last: Int
    $before: String
  ) {
    adminAccounts(first: $first, after: $after, last: $last, before: $before) {
      totalCount
      edges {
        cursor
        lastActivity
        node {
          uuid
          username
          postCount
          lastPostPublished
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`);

async function makeModerator(
  tx: Parameters<Parameters<typeof withRollback>[0]>[0],
  username: string,
) {
  const result = await insertAccountWithActor(tx, {
    username,
    name: `Moderator ${username}`,
    email: `${username}@example.com`,
  });
  await tx.update(accountTable).set({ moderator: true }).where(
    eq(accountTable.id, result.account.id),
  );
  return {
    ...result,
    account: { ...result.account, moderator: true },
  };
}

test("adminAccounts returns null for guest", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 10 },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as { adminAccounts: unknown }).adminAccounts,
      null,
    );
  });
});

test("adminAccounts returns null for non-moderator", async () => {
  await withRollback(async (tx) => {
    const normal = await insertAccountWithActor(tx, {
      username: "adminnonmod",
      name: "Non Mod",
      email: "adminnonmod@example.com",
    });
    const result = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 10 },
      contextValue: makeUserContext(tx, normal.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as { adminAccounts: unknown }).adminAccounts,
      null,
    );
  });
});

test("adminAccounts returns paginated AdminAccountConnection for moderator", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "adminmod1");
    // Create three other accounts.
    for (let i = 0; i < 3; i++) {
      await insertAccountWithActor(tx, {
        username: `adminuser${i}`,
        name: `Admin User ${i}`,
        email: `adminuser${i}@example.com`,
      });
    }
    const result = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 10 },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      adminAccounts: {
        totalCount: number;
        edges: { node: { username: string } }[];
      };
    };
    assert.deepEqual(data.adminAccounts.totalCount, 4);
    assert.deepEqual(data.adminAccounts.edges.length, 4);
    const usernames = data.adminAccounts.edges.map((e) => e.node.username)
      .sort();
    assert.deepEqual(
      usernames,
      ["adminmod1", "adminuser0", "adminuser1", "adminuser2"],
    );
  });
});

test("adminAccounts orders by latest post published falling back to account.updated", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "ordermod");

    // a posted most recently, b posted earlier, c never posted.
    const a = await insertAccountWithActor(tx, {
      username: "orderalice",
      name: "Order Alice",
      email: "orderalice@example.com",
    });
    const b = await insertAccountWithActor(tx, {
      username: "orderbob",
      name: "Order Bob",
      email: "orderbob@example.com",
    });
    const c = await insertAccountWithActor(tx, {
      username: "ordercarol",
      name: "Order Carol",
      email: "ordercarol@example.com",
    });

    // Set distinct `updated` timestamps on the no-post accounts so
    // ordering is deterministic.
    await tx.update(accountTable).set({
      updated: new Date("2026-04-01T00:00:00.000Z"),
    }).where(eq(accountTable.id, c.account.id));
    await tx.update(accountTable).set({
      updated: new Date("2026-03-01T00:00:00.000Z"),
    }).where(eq(accountTable.id, mod.account.id));

    await insertNotePost(tx, {
      account: a.account,
      published: new Date("2026-04-15T00:00:00.000Z"),
    });
    await insertNotePost(tx, {
      account: b.account,
      published: new Date("2026-04-10T00:00:00.000Z"),
    });

    const result = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 10 },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      adminAccounts: {
        edges: { node: { username: string } }[];
      };
    };
    // a (2026-04-15) > b (2026-04-10) > c.updated (2026-04-01)
    // > mod.updated (2026-03-01)
    assert.deepEqual(
      data.adminAccounts.edges.map((e) => e.node.username),
      ["orderalice", "orderbob", "ordercarol", "ordermod"],
    );
  });
});

test("adminAccounts pagination cursor round-trips correctly", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "paginmod");
    const others = [];
    // Distinct updated timestamps so ordering is stable.
    for (let i = 0; i < 5; i++) {
      const acc = await insertAccountWithActor(tx, {
        username: `paginuser${i}`,
        name: `Pagin User ${i}`,
        email: `paginuser${i}@example.com`,
      });
      await tx.update(accountTable).set({
        updated: new Date(`2026-04-${10 + i}T00:00:00.000Z`),
      }).where(eq(accountTable.id, acc.account.id));
      others.push(acc);
    }

    // First page.
    const first = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 2 },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(first.errors, undefined);
    const firstData = first.data as {
      adminAccounts: {
        edges: { cursor: string; node: { username: string } }[];
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    };
    assert.deepEqual(firstData.adminAccounts.edges.length, 2);
    assert.ok(firstData.adminAccounts.pageInfo.hasNextPage);

    // Second page.
    const second = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: {
        first: 2,
        after: firstData.adminAccounts.pageInfo.endCursor,
      },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(second.errors, undefined);
    const secondData = second.data as {
      adminAccounts: {
        edges: { cursor: string; node: { username: string } }[];
        pageInfo: { hasNextPage: boolean };
      };
    };
    assert.deepEqual(secondData.adminAccounts.edges.length, 2);

    // No overlap with the first page.
    const firstUsernames = firstData.adminAccounts.edges.map((e) =>
      e.node.username
    );
    const secondUsernames = secondData.adminAccounts.edges.map((e) =>
      e.node.username
    );
    for (const u of secondUsernames) {
      assert.ok(
        !firstUsernames.includes(u),
        `cursor leak: ${u} appears in both pages`,
      );
    }
  });
});

test("adminAccounts edge.lastActivity falls back to account.updated for no-post accounts", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "lastactmod");
    const noPosts = await insertAccountWithActor(tx, {
      username: "lastactnoposts",
      name: "No Posts",
      email: "lastactnoposts@example.com",
    });
    const updated = new Date("2026-04-12T00:00:00.000Z");
    await tx.update(accountTable).set({ updated }).where(
      eq(accountTable.id, noPosts.account.id),
    );

    const result = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 100 },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      adminAccounts: {
        edges: {
          lastActivity: Date | string;
          node: { username: string };
        }[];
      };
    };
    const edge = data.adminAccounts.edges.find(
      (e) => e.node.username === "lastactnoposts",
    );
    assert.ok(edge != null);
    const iso = edge.lastActivity instanceof Date
      ? edge.lastActivity.toISOString()
      : edge.lastActivity;
    assert.deepEqual(iso, updated.toISOString());
  });
});

test("adminAccounts cursor preserves microsecond precision across pages", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "microsecmod");
    // Two accounts with `updated` timestamps that differ only below
    // millisecond precision (microseconds 100 vs 900 of the same
    // millisecond).  If the cursor truncated to milliseconds, the
    // boundary would round and the second-page filter would skip
    // the row in the rounded window.
    const a = await insertAccountWithActor(tx, {
      username: "microseca",
      name: "Microsec A",
      email: "microseca@example.com",
    });
    const b = await insertAccountWithActor(tx, {
      username: "microsecb",
      name: "Microsec B",
      email: "microsecb@example.com",
    });
    await tx.execute(
      sql`UPDATE account SET updated = '2026-04-15 00:00:00.000900+00' WHERE id = ${a.account.id}`,
    );
    await tx.execute(
      sql`UPDATE account SET updated = '2026-04-15 00:00:00.000100+00' WHERE id = ${b.account.id}`,
    );
    await tx.update(accountTable).set({
      updated: new Date("2026-03-01T00:00:00.000Z"),
    }).where(eq(accountTable.id, mod.account.id));

    // First page: take just the first row (the moderator with the
    // newest .000900 microseconds will sort first… actually no, A
    // has .000900 which is bigger, so A comes first).
    const first = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 1 },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(first.errors, undefined);
    const firstData = first.data as {
      adminAccounts: {
        edges: { cursor: string; node: { username: string } }[];
      };
    };
    assert.deepEqual(
      firstData.adminAccounts.edges.map((e) => e.node.username),
      ["microseca"],
    );

    // Second page: the cursor must encode microseconds so that B
    // (whose .000100 is also rounded to .000 in millisecond mode)
    // is correctly returned and not skipped by the boundary.
    const second = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: {
        first: 1,
        after: firstData.adminAccounts.edges[0].cursor,
      },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(second.errors, undefined);
    const secondData = second.data as {
      adminAccounts: {
        edges: { node: { username: string } }[];
      };
    };
    assert.deepEqual(
      secondData.adminAccounts.edges.map((e) => e.node.username),
      ["microsecb"],
    );
  });
});

test("adminAccounts last+before traverses backwards consistently", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "backwardmod");
    // Distinct updated timestamps so ordering is stable and there is
    // no cursor ambiguity from equal timestamps.
    for (let i = 0; i < 5; i++) {
      const acc = await insertAccountWithActor(tx, {
        username: `backwarduser${i}`,
        name: `Backward User ${i}`,
        email: `backwarduser${i}@example.com`,
      });
      await tx.update(accountTable).set({
        updated: new Date(`2026-04-${10 + i}T00:00:00.000Z`),
      }).where(eq(accountTable.id, acc.account.id));
    }

    // Take the full natural order (first: 100) as the source of truth.
    const all = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 100 },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(all.errors, undefined);
    const allEdges = (all.data as {
      adminAccounts: {
        edges: { cursor: string; node: { username: string } }[];
      };
    }).adminAccounts.edges;
    assert.ok(allEdges.length >= 4);

    // Traverse backwards starting from the cursor of the THIRD edge:
    // last:2 + before:edges[2].cursor should return edges[0] and
    // edges[1] in natural order.
    const beforeCursor = allEdges[2].cursor;
    const back = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { last: 2, before: beforeCursor },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(back.errors, undefined);
    const backUsernames = (back.data as {
      adminAccounts: { edges: { node: { username: string } }[] };
    }).adminAccounts.edges.map((e) => e.node.username);
    assert.deepEqual(backUsernames, [
      allEdges[0].node.username,
      allEdges[1].node.username,
    ]);
  });
});

test("adminAccounts.totalCount equals overall account count", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "totalmod");
    for (let i = 0; i < 7; i++) {
      await insertAccountWithActor(tx, {
        username: `totaluser${i}`,
        name: `Total User ${i}`,
        email: `totaluser${i}@example.com`,
      });
    }
    const result = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 2 },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      adminAccounts: { totalCount: number; edges: unknown[] };
    };
    assert.deepEqual(data.adminAccounts.totalCount, 8);
    assert.deepEqual(data.adminAccounts.edges.length, 2);
  });
});

test("adminAccounts exposes Account.postCount for moderator", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "countmod");
    const target = await insertAccountWithActor(tx, {
      username: "counttarget",
      name: "Count Target",
      email: "counttarget@example.com",
    });
    for (let i = 0; i < 4; i++) {
      await insertNotePost(tx, {
        account: target.account,
        published: new Date(`2026-04-${10 + i}T00:00:00.000Z`),
      });
    }
    const result = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 10 },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      adminAccounts: {
        edges: {
          node: {
            username: string;
            postCount: number;
            lastPostPublished: Date | string | null;
          };
        }[];
      };
    };
    const targetEdge = data.adminAccounts.edges.find(
      (e) => e.node.username === "counttarget",
    );
    assert.ok(targetEdge != null);
    assert.deepEqual(targetEdge.node.postCount, 4);
    const ts = targetEdge.node.lastPostPublished;
    assert.ok(ts != null);
    const tsIso = ts instanceof Date ? ts.toISOString() : ts;
    assert.deepEqual(tsIso, "2026-04-13T00:00:00.000Z");
  });
});

const nonModeratorAccountByUsernameQuery = parse(`
  query NonModViewerStats($username: String!) {
    accountByUsername(username: $username) {
      username
      postCount
      lastPostPublished
    }
  }
`);

test("Account.postCount returns null for non-moderator viewing a different account, without null-bubbling", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "vieweronly",
      name: "Viewer Only",
      email: "vieweronly@example.com",
    });
    await insertAccountWithActor(tx, {
      username: "otherguy",
      name: "Other Guy",
      email: "otherguy@example.com",
    });
    const result = await execute({
      schema,
      document: nonModeratorAccountByUsernameQuery,
      variableValues: { username: "otherguy" },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    // The whole `accountByUsername` payload must still be present even
    // though the private fields evaluate to null when viewing someone
    // else's account as a non-moderator.
    const data = result.data as {
      accountByUsername: {
        username: string;
        postCount: number | null;
        lastPostPublished: string | null;
      } | null;
    };
    assert.ok(data.accountByUsername != null);
    assert.deepEqual(data.accountByUsername.username, "otherguy");
    assert.deepEqual(data.accountByUsername.postCount, null);
    assert.deepEqual(data.accountByUsername.lastPostPublished, null);
  });
});

test("Account.invitees.totalCount batches across rows in adminAccounts", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "inviteebatchmod");
    const inviter1 = await insertAccountWithActor(tx, {
      username: "inviteebatch1",
      name: "Inviter 1",
      email: "inviteebatch1@example.com",
    });
    const inviter2 = await insertAccountWithActor(tx, {
      username: "inviteebatch2",
      name: "Inviter 2",
      email: "inviteebatch2@example.com",
    });
    // inviter1 invited two accounts; inviter2 invited one.
    const invitees1 = [];
    for (let i = 0; i < 2; i++) {
      const inv = await insertAccountWithActor(tx, {
        username: `inviteechild1${i}`,
        name: `Child 1-${i}`,
        email: `inviteechild1${i}@example.com`,
      });
      invitees1.push(inv);
    }
    const inv2 = await insertAccountWithActor(tx, {
      username: "inviteechild2",
      name: "Child 2",
      email: "inviteechild2@example.com",
    });
    await tx.update(accountTable).set({ inviterId: inviter1.account.id })
      .where(
        inArray(
          accountTable.id,
          invitees1.map((i) => i.account.id),
        ),
      );
    await tx.update(accountTable).set({ inviterId: inviter2.account.id })
      .where(eq(accountTable.id, inv2.account.id));

    const queryWithInvitees = parse(`
      query AdminAccountsInvitees {
        adminAccounts(first: 100) {
          edges {
            node {
              username
              invitees(first: 0) { totalCount }
            }
          }
        }
      }
    `);
    const result = await execute({
      schema,
      document: queryWithInvitees,
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      adminAccounts: {
        edges: {
          node: { username: string; invitees: { totalCount: number } };
        }[];
      };
    };
    const byName = new Map(
      data.adminAccounts.edges.map((e) => [
        e.node.username,
        e.node.invitees.totalCount,
      ]),
    );
    assert.deepEqual(byName.get("inviteebatch1"), 2);
    assert.deepEqual(byName.get("inviteebatch2"), 1);
    assert.deepEqual(byName.get("inviteechild10"), 0);
  });
});

test("adminAccounts batches Account.postCount across rows (no N+1)", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "batchmod");
    const seeded = [];
    for (let i = 0; i < 3; i++) {
      const acc = await insertAccountWithActor(tx, {
        username: `batchuser${i}`,
        name: `Batch User ${i}`,
        email: `batchuser${i}@example.com`,
      });
      for (let j = 0; j < i + 1; j++) {
        await insertNotePost(tx, {
          account: acc.account,
          published: new Date(`2026-04-${10 + j}T00:00:00.000Z`),
        });
      }
      seeded.push(acc);
    }
    await insertAccountWithActor(tx, {
      username: "batchemptyuser",
      name: "Batch Empty",
      email: "batchemptyuser@example.com",
    });

    const result = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 100 },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      adminAccounts: {
        edges: {
          node: {
            username: string;
            postCount: number;
            lastPostPublished: Date | string | null;
          };
        }[];
      };
    };
    const byName = new Map(
      data.adminAccounts.edges.map((e) => [e.node.username, e.node]),
    );
    assert.deepEqual(byName.get("batchuser0")?.postCount, 1);
    assert.deepEqual(byName.get("batchuser1")?.postCount, 2);
    assert.deepEqual(byName.get("batchuser2")?.postCount, 3);
    assert.deepEqual(byName.get("batchemptyuser")?.postCount, 0);
    assert.deepEqual(byName.get("batchemptyuser")?.lastPostPublished, null);
  });
});

test("adminAccounts.lastPostPublished is null for accounts with no posts", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "emptymod");
    await insertAccountWithActor(tx, {
      username: "emptytarget",
      name: "Empty Target",
      email: "emptytarget@example.com",
    });
    const result = await execute({
      schema,
      document: adminAccountsQuery,
      variableValues: { first: 10 },
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      adminAccounts: {
        edges: {
          node: {
            username: string;
            postCount: number;
            lastPostPublished: string | null;
          };
        }[];
      };
    };
    const target = data.adminAccounts.edges.find(
      (e) => e.node.username === "emptytarget",
    );
    assert.ok(target != null);
    assert.deepEqual(target.node.postCount, 0);
    assert.deepEqual(target.node.lastPostPublished, null);
  });
});

const invitationRegenStatusQuery = parse(`
  query InvitationRegenerationStatus {
    invitationRegenerationStatus {
      lastRegenerated
      cutoffDate
      eligibleAccountsCount
      topThirdCount
    }
  }
`);

test("invitationRegenerationStatus returns null for guest", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: invitationRegenStatusQuery,
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as {
        invitationRegenerationStatus: unknown;
      }).invitationRegenerationStatus,
      null,
    );
  });
});

test("invitationRegenerationStatus returns null for non-moderator", async () => {
  await withRollback(async (tx) => {
    const normal = await insertAccountWithActor(tx, {
      username: "regenstatusnonmod",
      name: "Non Mod",
      email: "regenstatusnonmod@example.com",
    });
    const result = await execute({
      schema,
      document: invitationRegenStatusQuery,
      contextValue: makeUserContext(tx, normal.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as {
        invitationRegenerationStatus: unknown;
      }).invitationRegenerationStatus,
      null,
    );
  });
});

test("invitationRegenerationStatus returns null lastRegenerated when KV empty", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "regenstatusmod1");
    const { kv } = createTestKv();
    const result = await execute({
      schema,
      document: invitationRegenStatusQuery,
      contextValue: makeUserContext(tx, mod.account, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const status = (result.data as {
      invitationRegenerationStatus: {
        lastRegenerated: unknown;
      } | null;
    }).invitationRegenerationStatus;
    assert.ok(status != null);
    assert.deepEqual(status.lastRegenerated, null);
  });
});

test("invitationRegenerationStatus returns the stored timestamp from KV", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "regenstatusmod2");
    const { kv, store } = createTestKv();
    const stored = new Date("2026-04-12T00:00:00.000Z");
    store.set(INVITATIONS_LAST_REGEN_KEY, stored.toISOString());
    const result = await execute({
      schema,
      document: invitationRegenStatusQuery,
      contextValue: makeUserContext(tx, mod.account, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const status = (result.data as {
      invitationRegenerationStatus: {
        lastRegenerated: Date | string | null;
        cutoffDate: Date | string;
      } | null;
    }).invitationRegenerationStatus;
    assert.ok(status != null);
    assert.ok(status.lastRegenerated != null);
    const lastIso = status.lastRegenerated instanceof Date
      ? status.lastRegenerated.toISOString()
      : status.lastRegenerated;
    assert.deepEqual(lastIso, stored.toISOString());
    const cutoffIso = status.cutoffDate instanceof Date
      ? status.cutoffDate.toISOString()
      : status.cutoffDate;
    assert.deepEqual(cutoffIso, stored.toISOString());
  });
});

test("invitationRegenerationStatus reports eligible/topThird based on posts since cutoff", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "regenstatusmod3");
    const { kv, store } = createTestKv();
    const cutoff = new Date("2026-04-08T00:00:00.000Z");
    store.set(INVITATIONS_LAST_REGEN_KEY, cutoff.toISOString());

    // Two accounts with posts past cutoff, one without.
    const a = await insertAccountWithActor(tx, {
      username: "regenstateligible1",
      name: "Eligible 1",
      email: "regenstateligible1@example.com",
    });
    const b = await insertAccountWithActor(tx, {
      username: "regenstateligible2",
      name: "Eligible 2",
      email: "regenstateligible2@example.com",
    });
    await insertAccountWithActor(tx, {
      username: "regenstatineligible",
      name: "Ineligible",
      email: "regenstatineligible@example.com",
    });
    await insertNotePost(tx, {
      account: a.account,
      published: new Date("2026-04-09T00:00:00.000Z"),
    });
    await insertNotePost(tx, {
      account: b.account,
      published: new Date("2026-04-10T00:00:00.000Z"),
    });

    const result = await execute({
      schema,
      document: invitationRegenStatusQuery,
      contextValue: makeUserContext(tx, mod.account, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const status = (result.data as {
      invitationRegenerationStatus: {
        eligibleAccountsCount: number;
        topThirdCount: number;
      } | null;
    }).invitationRegenerationStatus;
    assert.ok(status != null);
    assert.deepEqual(status.eligibleAccountsCount, 2);
    assert.deepEqual(status.topThirdCount, 1);
  });
});

const regenerateMutation = parse(`
  mutation Regenerate {
    regenerateInvitations {
      __typename
      ... on RegenerateInvitationsPayload {
        accountsAffected
        regenerated
        status {
          lastRegenerated
          cutoffDate
          eligibleAccountsCount
          topThirdCount
        }
      }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
    }
  }
`);

test("regenerateInvitations returns NotAuthenticatedError for guest", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: regenerateMutation,
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as {
        regenerateInvitations: { __typename: string };
      }).regenerateInvitations.__typename,
      "NotAuthenticatedError",
    );
  });
});

test("regenerateInvitations returns NotAuthorizedError for non-moderator", async () => {
  await withRollback(async (tx) => {
    const normal = await insertAccountWithActor(tx, {
      username: "regenmutnonmod",
      name: "Non Mod",
      email: "regenmutnonmod@example.com",
    });
    const result = await execute({
      schema,
      document: regenerateMutation,
      contextValue: makeUserContext(tx, normal.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as {
        regenerateInvitations: { __typename: string };
      }).regenerateInvitations.__typename,
      "NotAuthorizedError",
    );
  });
});

test("regenerateInvitations grants +1 to top third and updates KV", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "regenmutmod1");
    const { kv, store } = createTestKv();
    // Pin a cutoff in the past so the seeded posts count as eligible.
    const cutoff = new Date("2026-04-01T00:00:00.000Z");
    store.set(INVITATIONS_LAST_REGEN_KEY, cutoff.toISOString());

    // Three eligible accounts; top third = 1.
    const winner = await insertAccountWithActor(tx, {
      username: "regenmutwinner",
      name: "Winner",
      email: "regenmutwinner@example.com",
    });
    const loser1 = await insertAccountWithActor(tx, {
      username: "regenmutloser1",
      name: "Loser 1",
      email: "regenmutloser1@example.com",
    });
    const loser2 = await insertAccountWithActor(tx, {
      username: "regenmutloser2",
      name: "Loser 2",
      email: "regenmutloser2@example.com",
    });
    // Winner: 5 posts, losers: 1 each.
    for (let i = 0; i < 5; i++) {
      await insertNotePost(tx, {
        account: winner.account,
        published: new Date(`2026-04-${10 + i}T00:00:00.000Z`),
      });
    }
    await insertNotePost(tx, {
      account: loser1.account,
      published: new Date("2026-04-12T00:00:00.000Z"),
    });
    await insertNotePost(tx, {
      account: loser2.account,
      published: new Date("2026-04-13T00:00:00.000Z"),
    });

    const result = await execute({
      schema,
      document: regenerateMutation,
      contextValue: makeUserContext(tx, mod.account, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const payload = (result.data as {
      regenerateInvitations: {
        __typename: string;
        accountsAffected: number;
        regenerated: Date | string;
        status: {
          lastRegenerated: Date | string | null;
        };
      };
    }).regenerateInvitations;
    assert.deepEqual(payload.__typename, "RegenerateInvitationsPayload");
    assert.deepEqual(payload.accountsAffected, 1);
    assert.ok(payload.status.lastRegenerated != null);

    // KV is updated.
    assert.ok(typeof store.get(INVITATIONS_LAST_REGEN_KEY) === "string");

    // Only the winner gains.
    const w = await tx.query.accountTable.findFirst({
      where: { id: winner.account.id },
    });
    const l1 = await tx.query.accountTable.findFirst({
      where: { id: loser1.account.id },
    });
    const l2 = await tx.query.accountTable.findFirst({
      where: { id: loser2.account.id },
    });
    assert.deepEqual(w?.leftInvitations, 1);
    assert.deepEqual(l1?.leftInvitations, 0);
    assert.deepEqual(l2?.leftInvitations, 0);
  });
});

test("regenerateInvitations payload.status reflects the new last-regen timestamp", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "regenmutmod2");
    const { kv } = createTestKv();
    const result = await execute({
      schema,
      document: regenerateMutation,
      contextValue: makeUserContext(tx, mod.account, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const payload = (result.data as {
      regenerateInvitations: {
        regenerated: Date | string;
        status: {
          lastRegenerated: Date | string | null;
        };
      };
    }).regenerateInvitations;
    const regenIso = payload.regenerated instanceof Date
      ? payload.regenerated.toISOString()
      : payload.regenerated;
    const lastIso = payload.status.lastRegenerated instanceof Date
      ? payload.status.lastRegenerated.toISOString()
      : payload.status.lastRegenerated;
    assert.deepEqual(regenIso, lastIso);
  });
});

test("regenerateInvitations does not credit accounts whose posts are dated in the future", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "regenmutmodfuture");
    const { kv, store } = createTestKv();
    // Pin a cutoff so the regen has eligible accounts to credit.
    const cutoff = new Date("2026-04-01T00:00:00.000Z");
    store.set(INVITATIONS_LAST_REGEN_KEY, cutoff.toISOString());

    const winner = await insertAccountWithActor(tx, {
      username: "regenmutfuturewinner",
      name: "Future Winner",
      email: "regenmutfuturewinner@example.com",
    });
    // A post-cutoff, past-dated post so the regen actually has
    // work to do.
    await insertNotePost(tx, {
      account: winner.account,
      published: new Date("2026-04-10T00:00:00.000Z"),
    });
    // A future-dated post (clock-skewed federation input or
    // scheduled post).  selectActiveAccounts clamps the eligibility
    // window to `now`, so this post should NOT make its account
    // eligible until its `published` becomes <= now.  After regen
    // moves the cutoff to "now", the status should report 0
    // eligible accounts (the past-dated winner has already been
    // credited and falls below the new cutoff; the future-dated
    // post is excluded by the clamp).
    const future = await insertAccountWithActor(tx, {
      username: "regenmutfutureposter",
      name: "Future Poster",
      email: "regenmutfutureposter@example.com",
    });
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await insertNotePost(tx, {
      account: future.account,
      published: farFuture,
    });

    const result = await execute({
      schema,
      document: regenerateMutation,
      contextValue: makeUserContext(tx, mod.account, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const payload = (result.data as {
      regenerateInvitations: {
        accountsAffected: number;
        status: { eligibleAccountsCount: number; topThirdCount: number };
      };
    }).regenerateInvitations;
    // Only the past-dated winner is credited; the future-dated
    // poster is excluded by the now-clamp.
    assert.deepEqual(payload.accountsAffected, 1);
    // Post-regen, the cutoff has moved to now, so no past-dated
    // post is eligible and the future-dated post is also excluded.
    assert.deepEqual(payload.status.eligibleAccountsCount, 0);
    assert.deepEqual(payload.status.topThirdCount, 0);

    // Confirm the future-dated poster was not credited.
    const futureRow = await tx.query.accountTable.findFirst({
      where: { id: future.account.id },
    });
    assert.deepEqual(futureRow?.leftInvitations, 0);
  });
});

const orphanMediaStatusQuery = parse(`
  query OrphanMediaStatus {
    orphanMediaStatus {
      cutoffDate
      orphanMediaCount
    }
  }
`);

test("orphanMediaStatus returns null for guest", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: orphanMediaStatusQuery,
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as { orphanMediaStatus: unknown }).orphanMediaStatus,
      null,
    );
  });
});

test("orphanMediaStatus counts old unreferenced media for moderators", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "orphanstatusmod");
    await insertTestMedium(
      tx,
      "media/graphql-orphan-status.webp",
      new Date("2020-01-01T00:00:00.000Z"),
    );
    await insertTestMedium(
      tx,
      "media/graphql-recent-status.webp",
      new Date(),
    );

    const result = await execute({
      schema,
      document: orphanMediaStatusQuery,
      contextValue: makeUserContext(tx, mod.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);
    const status = (result.data as {
      orphanMediaStatus: {
        orphanMediaCount: number;
        cutoffDate: Date | string;
      } | null;
    }).orphanMediaStatus;
    assert.ok(status != null);
    assert.deepEqual(status.orphanMediaCount, 1);
  });
});

const deleteOrphanMediaMutation = parse(`
  mutation DeleteOrphanMedia {
    deleteOrphanMedia {
      __typename
      ... on DeleteOrphanMediaPayload {
        deletedCount
        failedStorageDeletes
        status {
          orphanMediaCount
        }
      }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
    }
  }
`);

test("deleteOrphanMedia returns NotAuthenticatedError for guest", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: deleteOrphanMediaMutation,
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as {
        deleteOrphanMedia: { __typename: string };
      }).deleteOrphanMedia.__typename,
      "NotAuthenticatedError",
    );
  });
});

test("deleteOrphanMedia deletes old unreferenced media for moderators", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "orphanmutmod");
    const orphanId = await insertTestMedium(
      tx,
      "media/graphql-orphan-delete.webp",
      new Date("2020-01-01T00:00:00.000Z"),
    );
    const recentId = await insertTestMedium(
      tx,
      "media/graphql-recent-keep.webp",
      new Date(),
    );
    const disk = createTrackingDisk();

    const result = await execute({
      schema,
      document: deleteOrphanMediaMutation,
      contextValue: makeUserContext(tx, mod.account, { disk: disk.disk }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);
    const payload = (result.data as {
      deleteOrphanMedia: {
        __typename: string;
        deletedCount: number;
        failedStorageDeletes: number;
        status: { orphanMediaCount: number };
      };
    }).deleteOrphanMedia;
    assert.deepEqual(payload.__typename, "DeleteOrphanMediaPayload");
    assert.deepEqual(payload.deletedCount, 1);
    assert.deepEqual(payload.failedStorageDeletes, 0);
    assert.deepEqual(payload.status.orphanMediaCount, 0);
    assert.deepEqual(disk.deleteKeys, ["media/graphql-orphan-delete.webp"]);
    assert.deepEqual(
      await tx.query.mediumTable.findFirst({ where: { id: orphanId } }),
      undefined,
    );
    assert.ok(
      await tx.query.mediumTable.findFirst({ where: { id: recentId } }) !=
        null,
    );
  });
});

test("regenerateInvitations called twice in immediate succession returns 0 affected on second", async () => {
  await withRollback(async (tx) => {
    const mod = await makeModerator(tx, "regenmutmod3");
    const { kv, store } = createTestKv();
    // Pin a cutoff in the past so the seeded post counts as eligible.
    const cutoff = new Date("2026-04-01T00:00:00.000Z");
    store.set(INVITATIONS_LAST_REGEN_KEY, cutoff.toISOString());

    const a = await insertAccountWithActor(tx, {
      username: "regenmuttwicea",
      name: "Twice A",
      email: "regenmuttwicea@example.com",
    });
    await insertNotePost(tx, {
      account: a.account,
      published: new Date("2026-04-14T00:00:00.000Z"),
    });

    const first = await execute({
      schema,
      document: regenerateMutation,
      contextValue: makeUserContext(tx, mod.account, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(first.errors, undefined);
    assert.deepEqual(
      (first.data as {
        regenerateInvitations: { accountsAffected: number };
      }).regenerateInvitations.accountsAffected,
      1,
    );

    const second = await execute({
      schema,
      document: regenerateMutation,
      contextValue: makeUserContext(tx, mod.account, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(second.errors, undefined);
    assert.deepEqual(
      (second.data as {
        regenerateInvitations: { accountsAffected: number };
      }).regenerateInvitations.accountsAffected,
      0,
    );
  });
});
