import assert from "node:assert";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  createTestDisk,
  createTestKv,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";
import {
  deleteOrphanMedia,
  getInvitationRegenerationStatus,
  getInvitationsLastRegen,
  getOrphanMediaStatus,
  INVITATIONS_LAST_REGEN_KEY,
  regenerateInvitations,
} from "./admin.ts";
import {
  accountTable,
  adminStateTable,
  articleContentTable,
  articleDraftMediumTable,
  articleDraftTable,
  articleSourceMediumTable,
  articleSourceTable,
  mediumTable,
  noteSourceMediumTable,
  noteSourceTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

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
