import assert from "node:assert";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  deleteArticleDraft,
  getAccessibleArticleDraft,
  moveArticleDraftToOrganization,
  saveArticleDraft,
} from "./article.ts";
import {
  articleDraftMediumTable,
  articleDraftTable,
  mediumTable,
  organizationMembershipTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import { insertAccountWithActor, withRollback } from "../test/postgres.ts";

const timestamp = new Date("2026-04-15T00:00:00.000Z");

async function insertOrganization(
  tx: Parameters<Parameters<typeof withRollback>[0]>[0],
  username: string,
) {
  return await insertAccountWithActor(tx, {
    username,
    name: username,
    email: `${username}@example.com`,
    kind: "organization",
    type: "Organization",
  });
}

async function addOrganizationMember(
  tx: Parameters<Parameters<typeof withRollback>[0]>[0],
  organizationAccountId: `${string}-${string}-${string}-${string}-${string}`,
  memberAccountId: `${string}-${string}-${string}-${string}-${string}`,
  accepted: Date | null,
) {
  await tx.insert(organizationMembershipTable).values({
    organizationAccountId,
    memberAccountId,
    role: "member",
    accepted,
    created: timestamp,
    updated: timestamp,
  });
}

test("saveArticleDraft() normalizes tags and enforces revision conflicts", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "articledraftowner",
      name: "Article Draft Owner",
      email: "articledraftowner@example.com",
    });
    const draftId = generateUuidV7();

    const created = await saveArticleDraft(tx, owner.account, {
      uuid: draftId,
      title: "Draft title",
      content: "Draft content",
      tags: ["  #fediverse  ", "#fediverse", "solid", "", "bad,tag"],
    });
    assert.equal(created.status, "ok");
    if (created.status !== "ok") return;
    assert.equal(created.draft.id, draftId);
    assert.equal(created.draft.accountId, owner.account.id);
    assert.equal(created.draft.creatorId, owner.account.id);
    assert.equal(created.draft.revision, 1);
    assert.deepEqual(created.draft.tags, ["fediverse", "solid"]);

    const updated = await saveArticleDraft(tx, owner.account, {
      uuid: draftId,
      revision: created.draft.revision,
      title: "Updated title",
      content: "Updated content",
      tags: ["  #relay", "relay", "graphql "],
    });
    assert.equal(updated.status, "ok");
    if (updated.status !== "ok") return;
    assert.equal(updated.draft.title, "Updated title");
    assert.equal(updated.draft.revision, 2);
    assert.deepEqual(updated.draft.tags, ["relay", "graphql"]);

    const conflict = await saveArticleDraft(tx, owner.account, {
      uuid: draftId,
      revision: 1,
      title: "Stale",
      content: "Stale",
      tags: [],
    });
    assert.equal(conflict.status, "conflict");
    if (conflict.status !== "conflict") return;
    assert.equal(conflict.currentRevision, 2);

    const stillStored = await tx.query.articleDraftTable.findFirst({
      where: { id: draftId },
    });
    assert.equal(stillStored?.title, "Updated title");
  });
});

test("saveArticleDraft() rejects invalid input combinations", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "draftinputowner",
      name: "Draft Input Owner",
      email: "draftinputowner@example.com",
    });
    const draftId = generateUuidV7();
    const created = await saveArticleDraft(tx, owner.account, {
      uuid: draftId,
      title: "Title",
      content: "Content",
      tags: [],
    });
    assert.equal(created.status, "ok");

    assert.equal(
      (
        await saveArticleDraft(tx, owner.account, {
          id: draftId,
          uuid: draftId,
          revision: 1,
          title: "x",
          content: "x",
          tags: [],
        })
      ).status,
      "invalid",
    );
    assert.equal(
      (
        await saveArticleDraft(tx, owner.account, {
          id: draftId,
          title: "x",
          content: "x",
          tags: [],
        })
      ).status,
      "invalid",
    );
    assert.equal(
      (
        await saveArticleDraft(tx, owner.account, {
          revision: 1,
          title: "x",
          content: "x",
          tags: [],
        })
      ).status,
      "invalid",
    );
    assert.equal(
      (
        await saveArticleDraft(tx, owner.account, {
          uuid: draftId,
          revision: 0,
          title: "x",
          content: "x",
          tags: [],
        })
      ).status,
      "invalid",
    );
  });
});

test("organization members share drafts while non-members and pending invitees cannot", async () => {
  await withRollback(async (tx) => {
    const organization = await insertOrganization(tx, "shareddraftorg");
    const member = await insertAccountWithActor(tx, {
      username: "shareddraftmember",
      name: "Shared Draft Member",
      email: "shareddraftmember@example.com",
    });
    const outsider = await insertAccountWithActor(tx, {
      username: "shareddraftoutsider",
      name: "Shared Draft Outsider",
      email: "shareddraftoutsider@example.com",
    });
    const pending = await insertAccountWithActor(tx, {
      username: "shareddraftpending",
      name: "Shared Draft Pending",
      email: "shareddraftpending@example.com",
    });
    await addOrganizationMember(
      tx,
      organization.account.id,
      member.account.id,
      timestamp,
    );
    await addOrganizationMember(
      tx,
      organization.account.id,
      pending.account.id,
      null,
    );

    const draftId = generateUuidV7();
    const created = await saveArticleDraft(tx, member.account, {
      uuid: draftId,
      actingAccountId: organization.account.id,
      title: "Shared draft",
      content: "Shared body",
      tags: [],
    });
    assert.equal(created.status, "ok");
    if (created.status !== "ok") return;
    assert.equal(created.draft.accountId, organization.account.id);
    assert.equal(created.draft.creatorId, member.account.id);

    assert.ok(
      (await getAccessibleArticleDraft(tx, member.account, draftId)) != null,
    );
    assert.equal(
      await getAccessibleArticleDraft(tx, outsider.account, draftId),
      undefined,
    );

    const pendingCreate = await saveArticleDraft(tx, pending.account, {
      uuid: generateUuidV7(),
      actingAccountId: organization.account.id,
      title: "Pending draft",
      content: "Pending body",
      tags: [],
    });
    assert.equal(pendingCreate.status, "forbidden");

    const memberUpdate = await saveArticleDraft(tx, member.account, {
      id: draftId,
      revision: created.draft.revision,
      title: "Shared draft v2",
      content: "Shared body v2",
      tags: [],
    });
    assert.equal(memberUpdate.status, "ok");
    if (memberUpdate.status !== "ok") return;

    await tx
      .delete(organizationMembershipTable)
      .where(
        and(
          eq(
            organizationMembershipTable.organizationAccountId,
            organization.account.id,
          ),
          eq(organizationMembershipTable.memberAccountId, member.account.id),
        ),
      );

    assert.equal(
      await getAccessibleArticleDraft(tx, member.account, draftId),
      undefined,
    );
    const revokedUpdate = await saveArticleDraft(tx, member.account, {
      id: draftId,
      revision: memberUpdate.draft.revision,
      title: "Revoked",
      content: "Revoked",
      tags: [],
    });
    assert.equal(revokedUpdate.status, "invalid");
    const revokedDelete = await deleteArticleDraft(tx, member.account, {
      id: draftId,
    });
    assert.equal(revokedDelete.status, "invalid");
  });
});

test("moveArticleDraftToOrganization() preserves content, media, and creator", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "draftmoveowner",
      name: "Draft Move Owner",
      email: "draftmoveowner@example.com",
    });
    const organization = await insertOrganization(tx, "draftmoveorg");
    const other = await insertAccountWithActor(tx, {
      username: "draftmoveother",
      name: "Draft Move Other",
      email: "draftmoveother@example.com",
    });
    await addOrganizationMember(
      tx,
      organization.account.id,
      owner.account.id,
      timestamp,
    );

    const draftId = generateUuidV7();
    const created = await saveArticleDraft(tx, owner.account, {
      uuid: draftId,
      title: "Movable draft",
      content: "Movable body",
      tags: ["move"],
    });
    assert.equal(created.status, "ok");
    if (created.status !== "ok") return;

    const mediumId = generateUuidV7();
    await tx.insert(mediumTable).values({
      id: mediumId,
      key: `move-${mediumId}.png`,
      type: "image/png",
      created: timestamp,
    });
    await tx.insert(articleDraftMediumTable).values({
      articleDraftId: draftId,
      key: "figure",
      mediumId,
      created: timestamp,
    });

    const moved = await moveArticleDraftToOrganization(tx, owner.account, {
      id: draftId,
      organizationAccountId: organization.account.id,
      revision: created.draft.revision,
    });
    assert.equal(moved.status, "ok");
    if (moved.status !== "ok") return;
    assert.equal(moved.draft.accountId, organization.account.id);
    assert.equal(moved.draft.creatorId, owner.account.id);
    assert.equal(moved.draft.revision, created.draft.revision + 1);
    assert.equal(moved.draft.content, "Movable body");
    assert.deepEqual(moved.draft.tags, ["move"]);

    const relation = await tx.query.articleDraftMediumTable.findFirst({
      where: { articleDraftId: draftId, key: "figure" },
    });
    assert.equal(relation?.mediumId, mediumId);

    const nonOwnerMove = await moveArticleDraftToOrganization(
      tx,
      other.account,
      {
        id: draftId,
        organizationAccountId: organization.account.id,
        revision: moved.draft.revision,
      },
    );
    assert.equal(nonOwnerMove.status, "invalid");
  });
});

test("deleteArticleDraft() enforces ownership and stale saves cannot resurrect", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "draftdeleteowner",
      name: "Draft Delete Owner",
      email: "draftdeleteowner@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "draftdeleteother",
      name: "Draft Delete Other",
      email: "draftdeleteother@example.com",
    });
    const draftId = generateUuidV7();
    const draft = await saveArticleDraft(tx, owner.account, {
      uuid: draftId,
      title: "Owned draft",
      content: "Owned content",
      tags: [],
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;

    const wrongAccountDelete = await deleteArticleDraft(tx, other.account, {
      id: draftId,
    });
    assert.equal(wrongAccountDelete.status, "invalid");

    const deleted = await deleteArticleDraft(tx, owner.account, {
      id: draftId,
      revision: draft.draft.revision,
    });
    assert.equal(deleted.status, "ok");

    const stored = await tx.query.articleDraftTable.findFirst({
      where: { id: draftId },
    });
    assert.equal(stored, undefined);

    // A stale save carrying the deleted draft's id must not recreate it.
    const staleUpdate = await saveArticleDraft(tx, owner.account, {
      id: draftId,
      revision: draft.draft.revision,
      title: "Stale",
      content: "Stale",
      tags: [],
    });
    assert.equal(staleUpdate.status, "invalid");
    assert.equal(
      await tx.query.articleDraftTable.findFirst({ where: { id: draftId } }),
      undefined,
    );
  });
});

test("article_draft creator_id defaults from the owner for legacy inserts", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "drafttriggerowner",
      name: "Draft Trigger Owner",
      email: "drafttriggerowner@example.com",
    });
    const draftId = generateUuidV7();
    // The old writer does not know about `creator_id`, so the transition
    // trigger must fill it from the owning account.
    const rows = await tx
      .insert(articleDraftTable)
      .values({
        id: draftId,
        accountId: owner.account.id,
        title: "Triggered draft",
        content: "Triggered body",
        tags: [],
      })
      .returning();
    assert.equal(rows[0].creatorId, owner.account.id);
  });
});
