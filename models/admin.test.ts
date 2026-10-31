import assert from "node:assert";
import test from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../test/database.ts";
import {
  createTestDisk,
  createTestKv,
  insertAccountWithActor,
  insertNotePost,
  withExclusiveTestDatabase,
  withRollback,
} from "../test/postgres.ts";
import { registerPushNotificationTarget } from "./push.ts";
import {
  setWebPushConfigForTesting,
  setWebPushSenderForTesting,
} from "./webpush.ts";
import {
  deleteOrphanMedia,
  getInvitationAutoDistributionEnabled,
  getInvitationDistributions,
  getInvitationRegenerationStatus,
  getInvitationsLastRegen,
  getOrphanMediaStatus,
  grantInvitations,
  INVITATIONS_LAST_REGEN_KEY,
  MAX_INVITATION_BALANCE,
  MAX_INVITATION_GRANT,
  regenerateInvitations,
  setInvitationAutoDistributionEnabled,
} from "./admin.ts";
import {
  accountTable,
  actorTable,
  adminStateTable,
  articleContentTable,
  articleDraftMediumTable,
  articleDraftTable,
  articleSourceMediumTable,
  articleSourceTable,
  invitationDistributionTable,
  mediumTable,
  noteSourceMediumTable,
  noteSourceTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const validWebPushP256dh =
  "BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const validWebPushAuth = "AgICAgICAgICAgICAgICAg";

function createTrackingDisk(failingKeys = new Set<string>()) {
  const deleteKeys: string[] = [];
  const disk = createTestDisk();
  disk.delete = (key: string) => {
    deleteKeys.push(key);
    if (failingKeys.has(key)) return Promise.reject(new Error("failed"));
    return Promise.resolve(undefined);
  };
  return {
    deleteKeys,
    disk,
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

test("getInvitationsLastRegen returns null when DB and KV are empty", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    assert.deepEqual(await getInvitationsLastRegen(tx, kv), null);
  });
});

test("getInvitationsLastRegen falls back to KV when DB row is absent", async () => {
  await withRollback(async (tx) => {
    const { kv, store } = createTestKv();
    const ts = new Date("2026-04-15T10:30:00.000Z");
    store.set(INVITATIONS_LAST_REGEN_KEY, ts.toISOString());
    const out = await getInvitationsLastRegen(tx, kv);
    assert.ok(out != null);
    assert.deepEqual(out.toISOString(), ts.toISOString());
  });
});

test("getInvitationsLastRegen prefers the DB row over the KV fallback", async () => {
  await withRollback(async (tx) => {
    const { kv, store } = createTestKv();
    const dbTs = new Date("2026-04-15T10:30:00.000Z");
    const kvTs = new Date("2026-04-10T00:00:00.000Z");
    store.set(INVITATIONS_LAST_REGEN_KEY, kvTs.toISOString());
    await tx.insert(adminStateTable).values({
      key: INVITATIONS_LAST_REGEN_KEY,
      value: dbTs.toISOString(),
    });
    const out = await getInvitationsLastRegen(tx, kv);
    assert.ok(out != null);
    assert.deepEqual(out.toISOString(), dbTs.toISOString());
  });
});

test("getInvitationRegenerationStatus uses now-7d cutoff when KV key absent", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");
    const status = await getInvitationRegenerationStatus(tx, kv, { now });
    assert.deepEqual(status.lastRegenerated, null);
    assert.deepEqual(
      status.cutoffDate.toISOString(),
      new Date("2026-04-08T00:00:00.000Z").toISOString(),
    );
    assert.deepEqual(status.eligibleAccountsCount, 0);
    assert.deepEqual(status.topThirdCount, 0);
  });
});

test("getInvitationRegenerationStatus uses stored timestamp as cutoff", async () => {
  await withRollback(async (tx) => {
    const { kv, store } = createTestKv();
    const lastRegen = new Date("2026-04-10T00:00:00.000Z");
    store.set(INVITATIONS_LAST_REGEN_KEY, lastRegen.toISOString());
    const now = new Date("2026-04-15T00:00:00.000Z");
    const status = await getInvitationRegenerationStatus(tx, kv, { now });
    assert.ok(status.lastRegenerated != null);
    assert.deepEqual(
      status.lastRegenerated.toISOString(),
      lastRegen.toISOString(),
    );
    assert.deepEqual(status.cutoffDate.toISOString(), lastRegen.toISOString());
  });
});

test("getInvitationRegenerationStatus counts accounts with at least one post past cutoff", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");
    const cutoff = new Date("2026-04-08T00:00:00.000Z");

    const a = await insertAccountWithActor(tx, {
      username: "statusalice",
      name: "Status Alice",
      email: "statusalice@example.com",
    });
    const b = await insertAccountWithActor(tx, {
      username: "statusbob",
      name: "Status Bob",
      email: "statusbob@example.com",
    });
    const c = await insertAccountWithActor(tx, {
      username: "statuscarol",
      name: "Status Carol",
      email: "statuscarol@example.com",
    });

    // Two posts after cutoff for alice, one for bob, none for carol.
    await insertNotePost(tx, {
      account: a.account,
      published: new Date("2026-04-10T00:00:00.000Z"),
    });
    await insertNotePost(tx, {
      account: a.account,
      published: new Date("2026-04-11T00:00:00.000Z"),
    });
    await insertNotePost(tx, {
      account: b.account,
      published: new Date("2026-04-12T00:00:00.000Z"),
    });
    // Pre-cutoff post for carol — should not count.
    await insertNotePost(tx, {
      account: c.account,
      published: new Date("2026-04-01T00:00:00.000Z"),
    });

    const status = await getInvitationRegenerationStatus(tx, kv, {
      now,
    });
    assert.deepEqual(status.cutoffDate.toISOString(), cutoff.toISOString());
    assert.deepEqual(status.eligibleAccountsCount, 2);
    assert.deepEqual(status.topThirdCount, 1);
  });
});

test("regenerateInvitations grants +1 to the top third by post count", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");

    const a = await insertAccountWithActor(tx, {
      username: "regenalice",
      name: "Regen Alice",
      email: "regenalice@example.com",
    });
    const b = await insertAccountWithActor(tx, {
      username: "regenbob",
      name: "Regen Bob",
      email: "regenbob@example.com",
    });
    const c = await insertAccountWithActor(tx, {
      username: "regencarol",
      name: "Regen Carol",
      email: "regencarol@example.com",
    });

    // Alice: 5 posts, Bob: 3 posts, Carol: 1 post — top third (ceil(3/3)=1)
    // is just Alice.
    for (let i = 0; i < 5; i++) {
      await insertNotePost(tx, {
        account: a.account,
        published: new Date(`2026-04-${10 + i}T00:00:00.000Z`),
      });
    }
    for (let i = 0; i < 3; i++) {
      await insertNotePost(tx, {
        account: b.account,
        published: new Date(`2026-04-${10 + i}T00:00:00.000Z`),
      });
    }
    await insertNotePost(tx, {
      account: c.account,
      published: new Date("2026-04-10T00:00:00.000Z"),
    });

    const result = await regenerateInvitations(tx, kv, { now });
    assert.deepEqual(result.accountsAffected, 1);
    assert.deepEqual(result.regenerated.toISOString(), now.toISOString());

    const aRow = await tx.query.accountTable.findFirst({
      where: { id: a.account.id },
    });
    const bRow = await tx.query.accountTable.findFirst({
      where: { id: b.account.id },
    });
    const cRow = await tx.query.accountTable.findFirst({
      where: { id: c.account.id },
    });
    assert.deepEqual(aRow?.leftInvitations, 1);
    assert.deepEqual(bRow?.leftInvitations, 0);
    assert.deepEqual(cRow?.leftInvitations, 0);
  });
});

test("regenerateInvitations does not write the cutoff back to migration KV", async () => {
  await withRollback(async (tx) => {
    const { kv, store } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");
    await regenerateInvitations(tx, kv, { now });
    assert.deepEqual(store.get(INVITATIONS_LAST_REGEN_KEY), undefined);
  });
});

test("regenerateInvitations writes the cutoff into admin_state inside the same transaction", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");
    await regenerateInvitations(tx, kv, { now });
    const row = await tx.query.adminStateTable.findFirst({
      where: { key: INVITATIONS_LAST_REGEN_KEY },
    });
    assert.ok(row != null);
    assert.deepEqual(row.value, now.toISOString());
  });
});

test("getOrphanMediaStatus counts only old unreferenced media", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "orphanstatus",
      name: "Orphan Status",
      email: "orphanstatus@example.com",
    });
    const now = new Date("2026-04-15T00:00:00.000Z");
    const old = new Date("2026-04-13T00:00:00.000Z");
    const cutoff = new Date("2026-04-14T00:00:00.000Z");
    const recent = new Date("2026-04-14T12:00:00.000Z");

    await insertTestMedium(tx, "media/orphan.webp", old);
    await insertTestMedium(tx, "media/prefix.webp", old);
    await insertTestMedium(tx, "media/recent.webp", recent);

    const avatarMediumId = await insertTestMedium(tx, "media/avatar.webp", old);
    await tx
      .update(accountTable)
      .set({ avatarMediumId })
      .where(eq(accountTable.id, account.account.id));

    const noteMediumId = await insertTestMedium(tx, "media/note.webp", old);
    const noteSourceId = generateUuidV7();
    await tx.insert(noteSourceTable).values({
      id: noteSourceId,
      accountId: account.account.id,
      content: "note",
      language: "en",
    });
    await tx.insert(noteSourceMediumTable).values({
      sourceId: noteSourceId,
      index: 0,
      mediumId: noteMediumId,
      alt: "",
    });

    const draftMediumId = await insertTestMedium(tx, "media/draft.webp", old);
    const draftId = generateUuidV7();
    await tx.insert(articleDraftTable).values({
      id: draftId,
      accountId: account.account.id,
      title: "Draft",
      content: "draft",
    });
    await tx.insert(articleDraftMediumTable).values({
      articleDraftId: draftId,
      key: "draft-key",
      mediumId: draftMediumId,
    });
    const directDraftMediumId = await insertTestMedium(
      tx,
      "media/direct-draft.webp",
      old,
    );
    const directFsDraftMediumId = await insertTestMedium(
      tx,
      "media/direct-fs-draft.webp",
      old,
    );
    const directDraftId = generateUuidV7();
    await tx.insert(articleDraftTable).values({
      id: directDraftId,
      accountId: account.account.id,
      title: "Direct draft",
      content: `![direct](/media/direct-draft.webp) ![fs](/media/media/direct-fs-draft.webp) ![prefix](/media/media/prefix.webp-extra)`,
    });

    const sourceMediumId = await insertTestMedium(tx, "media/source.webp", old);
    const sourceId = generateUuidV7();
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: account.account.id,
      slug: "source",
      published: new Date("2026-04-15T00:00:00.000Z"),
    });
    await tx.insert(articleSourceMediumTable).values({
      articleSourceId: sourceId,
      key: "source-key",
      mediumId: sourceMediumId,
    });
    const directSourceMediumId = await insertTestMedium(
      tx,
      "media/direct-source.webp",
      old,
    );
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Direct source",
      content: `![direct](hp-medium:media/direct-source.webp) ![prefix](hp-medium:media/prefix.webp-extra)`,
    });

    const status = await getOrphanMediaStatus(tx, { now });
    assert.deepEqual(status.cutoffDate.toISOString(), cutoff.toISOString());
    assert.deepEqual(status.orphanMediaCount, 2);
    assert.ok(
      (await tx.query.mediumTable.findFirst({
        where: { id: directDraftMediumId },
      })) != null,
    );
    assert.ok(
      (await tx.query.mediumTable.findFirst({
        where: { id: directFsDraftMediumId },
      })) != null,
    );
    assert.ok(
      (await tx.query.mediumTable.findFirst({
        where: { id: directSourceMediumId },
      })) != null,
    );
  });
});

test("deleteOrphanMedia removes old unreferenced rows and disk objects", async () => {
  await withRollback(async (tx) => {
    const now = new Date("2026-04-15T00:00:00.000Z");
    const old = new Date("2026-04-13T00:00:00.000Z");
    const cutoff = new Date("2026-04-14T00:00:00.000Z");
    const recent = new Date("2026-04-14T12:00:00.000Z");
    const orphanId = await insertTestMedium(
      tx,
      "media/orphan-delete.webp",
      old,
    );
    const recentId = await insertTestMedium(
      tx,
      "media/recent-keep.webp",
      recent,
    );
    const disk = createTrackingDisk();

    const result = await deleteOrphanMedia(tx, disk.disk, { now });

    assert.deepEqual(result.cutoffDate.toISOString(), cutoff.toISOString());
    assert.deepEqual(result.deletedCount, 1);
    assert.deepEqual(result.failedDiskDeletes, 0);
    assert.deepEqual(disk.deleteKeys, ["media/orphan-delete.webp"]);
    assert.deepEqual(
      await tx.query.mediumTable.findFirst({ where: { id: orphanId } }),
      undefined,
    );
    assert.ok(
      (await tx.query.mediumTable.findFirst({ where: { id: recentId } })) !=
        null,
    );
  });
});

test("deleteOrphanMedia reports disk failures after deleting rows", async () => {
  await withRollback(async (tx) => {
    const now = new Date("2026-04-15T00:00:00.000Z");
    const old = new Date("2026-04-13T00:00:00.000Z");
    const failedId = await insertTestMedium(
      tx,
      "media/orphan-delete-fail.webp",
      old,
    );
    const deletedId = await insertTestMedium(
      tx,
      "media/orphan-delete-ok.webp",
      old,
    );
    const disk = createTrackingDisk(new Set(["media/orphan-delete-fail.webp"]));

    const result = await deleteOrphanMedia(tx, disk.disk, { now });

    assert.deepEqual(result.deletedCount, 2);
    assert.deepEqual(result.failedDiskDeletes, 1);
    assert.deepEqual(disk.deleteKeys.toSorted(), [
      "media/orphan-delete-fail.webp",
      "media/orphan-delete-ok.webp",
    ]);
    assert.deepEqual(
      await tx.query.mediumTable.findFirst({ where: { id: failedId } }),
      undefined,
    );
    assert.deepEqual(
      await tx.query.mediumTable.findFirst({ where: { id: deletedId } }),
      undefined,
    );
  });
});

test("regenerateInvitations falls back to one-week cutoff when KV key absent", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");

    const a = await insertAccountWithActor(tx, {
      username: "fallbackalice",
      name: "Fallback Alice",
      email: "fallbackalice@example.com",
    });

    // Within one week of `now` — counts.
    await insertNotePost(tx, {
      account: a.account,
      published: new Date("2026-04-10T00:00:00.000Z"),
    });
    // More than one week before `now` — should NOT count.
    await insertNotePost(tx, {
      account: a.account,
      published: new Date("2026-04-01T00:00:00.000Z"),
    });

    const result = await regenerateInvitations(tx, kv, { now });
    assert.deepEqual(result.accountsAffected, 1);
    assert.deepEqual(
      result.cutoffDate.toISOString(),
      new Date("2026-04-08T00:00:00.000Z").toISOString(),
    );
  });
});

test("regenerateInvitations is a no-op when no accounts have posted", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");

    // Account exists but has no posts since cutoff.
    const a = await insertAccountWithActor(tx, {
      username: "silentalice",
      name: "Silent Alice",
      email: "silentalice@example.com",
    });

    const result = await regenerateInvitations(tx, kv, { now });
    assert.deepEqual(result.accountsAffected, 0);
    // Timestamp is still updated.
    const stateRow = await tx.query.adminStateTable.findFirst({
      where: { key: INVITATIONS_LAST_REGEN_KEY },
    });
    assert.deepEqual(stateRow?.value, now.toISOString());
    const aRow = await tx.query.accountTable.findFirst({
      where: { id: a.account.id },
    });
    assert.deepEqual(aRow?.leftInvitations, 0);
  });
});

test("regenerateInvitations rounds up via ceil(active/3) — 3 active picks 1", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");

    // Three eligible accounts; top third is ceil(3/3) = 1.
    const accounts = [];
    for (let i = 0; i < 3; i++) {
      const acc = await insertAccountWithActor(tx, {
        username: `ceilalice${i}`,
        name: `Ceil Alice ${i}`,
        email: `ceilalice${i}@example.com`,
      });
      // Decreasing post counts: 3, 2, 1.
      for (let j = 0; j < 3 - i; j++) {
        await insertNotePost(tx, {
          account: acc.account,
          published: new Date(`2026-04-${10 + j}T00:00:00.000Z`),
        });
      }
      accounts.push(acc);
    }

    const result = await regenerateInvitations(tx, kv, { now });
    assert.deepEqual(result.accountsAffected, 1);

    // Only the most prolific (index 0) should get the bump.
    const updated = await Promise.all(
      accounts.map((a) =>
        tx.query.accountTable.findFirst({ where: { id: a.account.id } }),
      ),
    );
    assert.deepEqual(updated[0]?.leftInvitations, 1);
    assert.deepEqual(updated[1]?.leftInvitations, 0);
    assert.deepEqual(updated[2]?.leftInvitations, 0);
  });
});

test("regenerateInvitations called twice in immediate succession returns 0 affected on second", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();

    const a = await insertAccountWithActor(tx, {
      username: "twicealice",
      name: "Twice Alice",
      email: "twicealice@example.com",
    });
    await insertNotePost(tx, {
      account: a.account,
      published: new Date("2026-04-14T00:00:00.000Z"),
    });

    const first = await regenerateInvitations(tx, kv, {
      now: new Date("2026-04-15T00:00:00.000Z"),
    });
    assert.deepEqual(first.accountsAffected, 1);

    const second = await regenerateInvitations(tx, kv, {
      now: new Date("2026-04-15T00:00:01.000Z"),
    });
    assert.deepEqual(second.accountsAffected, 0);

    // Alice should still only have +1 total.
    const aRow = await tx.query.accountTable.findFirst({
      where: { id: a.account.id },
    });
    assert.deepEqual(aRow?.leftInvitations, 1);
  });
});

test("regenerateInvitations does not credit accounts whose only posts pre-date cutoff", async () => {
  await withRollback(async (tx) => {
    const { kv, store } = createTestKv();
    store.set(
      INVITATIONS_LAST_REGEN_KEY,
      new Date("2026-04-10T00:00:00.000Z").toISOString(),
    );

    const a = await insertAccountWithActor(tx, {
      username: "stalealice",
      name: "Stale Alice",
      email: "stalealice@example.com",
    });
    // Post pre-dates the cutoff.
    await insertNotePost(tx, {
      account: a.account,
      published: new Date("2026-04-09T00:00:00.000Z"),
    });
    // Existing leftInvitations to confirm we don't accidentally bump it.
    await tx
      .update(accountTable)
      .set({ leftInvitations: 2 })
      .where(eq(accountTable.id, a.account.id));

    const result = await regenerateInvitations(tx, kv, {
      now: new Date("2026-04-15T00:00:00.000Z"),
    });
    assert.deepEqual(result.accountsAffected, 0);
    const aRow = await tx.query.accountTable.findFirst({
      where: { id: a.account.id },
    });
    assert.deepEqual(aRow?.leftInvitations, 2);
  });
});

test("regenerateInvitations records a scheduled distribution and deduplicates its run key", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");
    const account = await insertAccountWithActor(tx, {
      username: "ledgeralice",
      name: "Ledger Alice",
      email: "ledgeralice@example.com",
    });
    await insertNotePost(tx, {
      account: account.account,
      published: new Date("2026-04-10T00:00:00.000Z"),
    });

    const runKey = `scheduled:${now.toISOString()}`;
    const first = await regenerateInvitations(tx, kv, {
      now,
      source: "scheduled",
      runKey,
    });
    assert.equal(first.skipped, false);
    assert.equal(first.accountsAffected, 1);
    assert.equal(first.distribution?.kind, "scheduled");
    assert.equal(first.distribution?.amount, 1);
    assert.equal(first.distribution?.accountsAffected, 1);
    assert.equal(first.distribution?.runKey, runKey);
    assert.equal(
      first.distribution?.periodEnd?.toISOString(),
      now.toISOString(),
    );

    const second = await regenerateInvitations(tx, kv, {
      now,
      source: "scheduled",
      runKey,
    });
    assert.equal(second.skipped, true);
    assert.equal(second.skipReason, "duplicate");
    assert.equal(second.distribution?.id, first.distribution?.id);
    assert.equal(second.accountsAffected, 1);

    const rows = await tx.query.invitationDistributionTable.findMany();
    assert.equal(rows.length, 1);
    const accountRow = await tx.query.accountTable.findFirst({
      where: { id: account.account.id },
    });
    assert.equal(accountRow?.leftInvitations, 1);
  });
});

test("regenerateInvitations treats a delayed tick as superseded without rewinding the cutoff", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const account = await insertAccountWithActor(tx, {
      username: "supersededalice",
      name: "Superseded Alice",
      email: "supersededalice@example.com",
    });
    await insertNotePost(tx, {
      account: account.account,
      published: new Date("2026-04-10T00:00:00.000Z"),
    });
    const later = new Date("2026-04-15T00:00:00.000Z");
    const first = await regenerateInvitations(tx, kv, {
      now: later,
      source: "manual",
    });
    assert.equal(first.distribution?.kind, "manual");

    const stale = await regenerateInvitations(tx, kv, {
      now: new Date("2026-04-14T00:00:00.000Z"),
      source: "scheduled",
      runKey: "scheduled:2026-04-14T00:00:00.000Z",
    });
    assert.equal(stale.skipped, true);
    assert.equal(stale.skipReason, "superseded");
    assert.equal(stale.distribution, null);
    assert.equal(stale.periodEnd.toISOString(), later.toISOString());

    const state = await tx.query.adminStateTable.findFirst({
      where: { key: INVITATIONS_LAST_REGEN_KEY },
    });
    assert.equal(state?.value, later.toISOString());
    const rows = await tx.query.invitationDistributionTable.findMany();
    assert.equal(rows.length, 1);
  });
});

test("regenerateInvitations records an empty committed run", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");
    const result = await regenerateInvitations(tx, kv, {
      now,
      source: "scheduled",
      runKey: "scheduled:2026-04-15T00:00:00.000Z",
    });
    assert.equal(result.skipped, false);
    assert.equal(result.accountsAffected, 0);
    assert.equal(result.distribution?.amount, 0);
    assert.equal(result.distribution?.accountsAffected, 0);
    assert.equal(result.distribution?.eligibleAccountsCount, 0);
  });
});

test("regenerateInvitations skips accounts at the balance ceiling", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");
    const account = await insertAccountWithActor(tx, {
      username: "saturatedalice",
      name: "Saturated Alice",
      email: "saturatedalice@example.com",
    });
    await tx
      .update(accountTable)
      .set({ leftInvitations: MAX_INVITATION_BALANCE })
      .where(eq(accountTable.id, account.account.id));
    await insertNotePost(tx, {
      account: account.account,
      published: new Date("2026-04-10T00:00:00.000Z"),
    });

    const result = await regenerateInvitations(tx, kv, {
      now,
      source: "scheduled",
      runKey: "scheduled:2026-04-15T00:00:00.000Z",
    });
    assert.equal(result.accountsAffected, 0);
    assert.equal(result.distribution?.topThirdCount, 1);
    assert.equal(result.distribution?.amount, 0);
    const accountRow = await tx.query.accountTable.findFirst({
      where: { id: account.account.id },
    });
    assert.equal(accountRow?.leftInvitations, MAX_INVITATION_BALANCE);
  });
});

test("grantInvitations updates the balance, records the grant, and notifies only a zero-balance recipient", async () => {
  await withRollback(async (tx) => {
    const actor = await insertAccountWithActor(tx, {
      username: "grantactor",
      name: "Grant Actor",
      email: "grantactor@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "granttarget",
      name: "Grant Target",
      email: "granttarget@example.com",
    });

    const first = await grantInvitations(tx, {
      accountId: target.account.id,
      actorId: actor.account.id,
      amount: 3,
      note: "Welcome aboard",
      now: new Date("2026-04-15T00:00:00.000Z"),
    });
    assert.ok(first != null);
    assert.equal(first.granted, 3);
    assert.equal(first.previousBalance, 0);
    assert.equal(first.newBalance, 3);
    assert.equal(first.distribution.kind, "grant");
    assert.equal(first.distribution.targetUsername, "granttarget");
    assert.equal(first.distribution.actorUsername, "grantactor");
    assert.equal(first.distribution.note, "Welcome aboard");

    const notifications = await tx.query.notificationTable.findMany({
      where: { accountId: target.account.id, type: "invitation_granted" },
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].invitationAmount, 3);
    assert.deepEqual(notifications[0].actorIds, [actor.actor.id]);

    const second = await grantInvitations(tx, {
      accountId: target.account.id,
      actorId: actor.account.id,
      amount: 1,
    });
    assert.ok(second != null);
    assert.equal(second.previousBalance, 3);
    assert.equal(second.newBalance, 4);
    const afterSecond = await tx.query.notificationTable.findMany({
      where: { accountId: target.account.id, type: "invitation_granted" },
    });
    assert.equal(afterSecond.length, 1);

    await tx
      .update(accountTable)
      .set({ leftInvitations: MAX_INVITATION_BALANCE - 1 })
      .where(eq(accountTable.id, target.account.id));
    await assert.rejects(
      grantInvitations(tx, {
        accountId: target.account.id,
        actorId: actor.account.id,
        amount: 2,
      }),
      /INVITATION_BALANCE_OVERFLOW/,
    );
    const afterOverflow = await tx.query.accountTable.findFirst({
      where: { id: target.account.id },
    });
    assert.equal(afterOverflow?.leftInvitations, MAX_INVITATION_BALANCE - 1);
  });
});

test("grantInvitations rejects invalid amounts and notes without changing the balance", async () => {
  await withRollback(async (tx) => {
    const actor = await insertAccountWithActor(tx, {
      username: "invalidgrantactor",
      name: "Invalid Grant Actor",
      email: "invalidgrantactor@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "invalidgranttarget",
      name: "Invalid Grant Target",
      email: "invalidgranttarget@example.com",
    });
    for (const amount of [0, -1, MAX_INVITATION_GRANT + 1, 1.5]) {
      await assert.rejects(
        grantInvitations(tx, {
          accountId: target.account.id,
          actorId: actor.account.id,
          amount,
        }),
        /INVALID_AMOUNT/,
      );
    }
    await assert.rejects(
      grantInvitations(tx, {
        accountId: target.account.id,
        actorId: actor.account.id,
        amount: 1,
        note: "x".repeat(501),
      }),
      /INVALID_NOTE/,
    );
    assert.equal(
      await grantInvitations(tx, {
        accountId: generateUuidV7(),
        actorId: actor.account.id,
        amount: 1,
      }),
      null,
    );
    const targetRow = await tx.query.accountTable.findFirst({
      where: { id: target.account.id },
    });
    assert.equal(targetRow?.leftInvitations, 0);
    const grants = await tx.query.invitationDistributionTable.findMany();
    assert.equal(grants.length, 0);
  });
});

test("grantInvitations keeps username snapshots after the target and actor are deleted", async () => {
  await withRollback(async (tx) => {
    const actor = await insertAccountWithActor(tx, {
      username: "deletedactor",
      name: "Deleted Actor",
      email: "deletedactor@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "deletedtarget",
      name: "Deleted Target",
      email: "deletedtarget@example.com",
    });
    const result = await grantInvitations(tx, {
      accountId: target.account.id,
      actorId: actor.account.id,
      amount: 1,
    });
    assert.ok(result != null);
    await tx.delete(accountTable).where(eq(accountTable.id, target.account.id));
    await tx.delete(accountTable).where(eq(accountTable.id, actor.account.id));
    const row = await tx.query.invitationDistributionTable.findFirst({
      where: { id: result.distribution.id },
    });
    assert.equal(row?.targetId, null);
    assert.equal(row?.targetUsername, "deletedtarget");
    assert.equal(row?.actorId, null);
    assert.equal(row?.actorUsername, "deletedactor");
  });
});

test("invitation distribution history paginates with exact PostgreSQL timestamps", async () => {
  await withRollback(async (tx) => {
    const insert = async (id: Uuid, created: string) => {
      await tx.insert(invitationDistributionTable).values({
        id,
        kind: "manual",
        amount: 0,
        accountsAffected: 0,
        eligibleAccountsCount: 0,
        topThirdCount: 0,
        cutoffDate: new Date("2026-04-01T00:00:00.000Z"),
        periodEnd: new Date("2026-04-15T00:00:00.000Z"),
        created: sql`${created}::timestamptz`,
      });
    };
    await insert(generateUuidV7(), "2026-04-15 00:00:00.123456+00");
    await insert(generateUuidV7(), "2026-04-15 00:00:00.123123+00");
    await insert(generateUuidV7(), "2026-04-15 00:00:00.122999+00");

    const first = await getInvitationDistributions(tx, { first: 1 });
    assert.equal(first.edges.length, 1);
    assert.equal(first.hasNextPage, true);
    assert.ok(first.endCursor != null);
    const second = await getInvitationDistributions(tx, {
      first: 2,
      after: first.endCursor!,
    });
    assert.equal(second.edges.length, 2);
    assert.equal(second.hasNextPage, false);
    const ids = [
      first.edges[0].distribution.id,
      ...second.edges.map((edge) => edge.distribution.id),
    ];
    assert.equal(new Set(ids).size, 3);
  });
});

test("invitation auto distribution kill switch defaults on and can be toggled", async () => {
  await withRollback(async (tx) => {
    assert.equal(await getInvitationAutoDistributionEnabled(tx), true);
    await setInvitationAutoDistributionEnabled(tx, false);
    assert.equal(await getInvitationAutoDistributionEnabled(tx), false);
    const status = await getInvitationRegenerationStatus(tx, undefined, {
      now: new Date("2026-04-15T00:00:00.000Z"),
    });
    assert.equal(status.autoDistributionEnabled, false);
    await setInvitationAutoDistributionEnabled(tx, true);
    assert.equal(await getInvitationAutoDistributionEnabled(tx), true);
  });
});

test("regenerateInvitations notifies accounts that crossed from zero to one", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const now = new Date("2026-04-15T00:00:00.000Z");
    const account = await insertAccountWithActor(tx, {
      username: "bulknotifyalice",
      name: "Bulk Notify Alice",
      email: "bulknotifyalice@example.com",
    });
    await insertNotePost(tx, {
      account: account.account,
      published: new Date("2026-04-10T00:00:00.000Z"),
    });
    const result = await regenerateInvitations(tx, kv, {
      now,
      source: "scheduled",
      runKey: `scheduled:${now.toISOString()}`,
    });
    assert.equal(result.accountsAffected, 1);
    const notifications = await tx.query.notificationTable.findMany({
      where: { accountId: account.account.id, type: "invitation_granted" },
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].invitationAmount, 1);
    assert.deepEqual(notifications[0].actorIds, []);
  });
});

test("grantInvitations sends the invitation push after commit", async () => {
  const sent: Array<{ endpoint: string; payload: string }> = [];
  setWebPushConfigForTesting({
    publicKey: "test-public-key",
    privateKey: "test-private-key",
    subject: "mailto:test@example.com",
  });
  setWebPushSenderForTesting(async (subscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, payload });
  });
  try {
    await withExclusiveTestDatabase(async () => {
      const suffix = generateUuidV7().replaceAll("-", "").slice(0, 8);
      const fixtures = await db.transaction(async (tx) => {
        const actor = await insertAccountWithActor(tx, {
          username: `pushactor${suffix}`,
          name: "Push Actor",
          email: `pushactor${suffix}@example.com`,
        });
        const target = await insertAccountWithActor(tx, {
          username: `pushtarget${suffix}`,
          name: "Push Target",
          email: `pushtarget${suffix}@example.com`,
        });
        return { actor, target };
      });
      try {
        await registerPushNotificationTarget(db, fixtures.target.account.id, {
          service: "web_push",
          subscription: {
            endpoint: `https://push.example/grant-${suffix}`,
            p256dh: validWebPushP256dh,
            auth: validWebPushAuth,
          },
        });
        const result = await grantInvitations(db, {
          accountId: fixtures.target.account.id,
          actorId: fixtures.actor.account.id,
          amount: 1,
        });
        assert.ok(result != null);
        const [notification] = await db.query.notificationTable.findMany({
          where: {
            accountId: fixtures.target.account.id,
            type: "invitation_granted",
          },
        });
        assert.ok(notification != null);
        assert.equal(sent.length, 1);
        assert.equal(
          JSON.parse(sent[0].payload).data.notificationId,
          notification.id,
        );
        assert.equal(
          JSON.parse(sent[0].payload).data.type,
          "invitation_granted",
        );
        await db
          .delete(invitationDistributionTable)
          .where(eq(invitationDistributionTable.id, result.distribution.id));
      } finally {
        await db
          .delete(accountTable)
          .where(
            inArray(accountTable.id, [
              fixtures.actor.account.id,
              fixtures.target.account.id,
            ]),
          );
      }
    });
  } finally {
    setWebPushConfigForTesting(undefined);
    setWebPushSenderForTesting(undefined);
  }
});

test("getInvitationDistributions ignores cursors with invalid calendar fields", async () => {
  await withRollback(async (tx) => {
    const id = generateUuidV7();
    await tx.insert(invitationDistributionTable).values({
      id,
      kind: "manual",
      amount: 0,
      accountsAffected: 0,
      eligibleAccountsCount: 0,
      topThirdCount: 0,
      cutoffDate: new Date("2026-04-01T00:00:00.000Z"),
      periodEnd: new Date("2026-04-15T00:00:00.000Z"),
    });
    const after = btoa(`2026-99-99 00:00:00.000000+00|${id}`);
    const page = await getInvitationDistributions(tx, { first: 1, after });
    assert.equal(page.edges.length, 1);
    assert.equal(page.edges[0]?.distribution.id, id);
  });
});

test("grantInvitations rejects a zero-balance grant whose moderator has no actor", async () => {
  await withRollback(async (tx) => {
    const actor = await insertAccountWithActor(tx, {
      username: "noactorgrantactor",
      name: "No Actor Grant Actor",
      email: "noactorgrantactor@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "noactorgranttarget",
      name: "No Actor Grant Target",
      email: "noactorgranttarget@example.com",
    });
    await tx
      .delete(actorTable)
      .where(eq(actorTable.accountId, actor.account.id));
    await assert.rejects(
      grantInvitations(tx, {
        accountId: target.account.id,
        actorId: actor.account.id,
        amount: 1,
      }),
      /has no actor row/,
    );
    const targetRow = await tx.query.accountTable.findFirst({
      where: { id: target.account.id },
    });
    assert.equal(targetRow?.leftInvitations, 0);
  });
});
