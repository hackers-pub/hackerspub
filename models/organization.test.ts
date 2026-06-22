import assert from "node:assert";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import {
  acceptOrganizationConversion,
  acceptOrganizationInvitation,
  createOrganization,
  getOrganizationNotificationBadge,
  inviteOrganizationMember,
  leaveOrganization,
  requestOrganizationConversion,
} from "./organization.ts";
import {
  accountEmailTable,
  accountTable,
  notificationTable,
  organizationMembershipTable,
} from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";

test("createOrganization() consumes one invitation and creates an Organization actor", async () => {
  await withRollback(async (tx) => {
    const creator = await insertAccountWithActor(tx, {
      username: "orgcreator",
      name: "Org Creator",
      email: "orgcreator@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, creator.account.id));
    const fedCtx = createFedCtx(tx);

    const organization = await createOrganization(fedCtx, creator.account, {
      username: "hackerspubcore",
      name: "Hackers' Pub Core",
      bio: "Core maintainers",
    });

    assert.equal(organization.kind, "organization");
    assert.equal(organization.username, "hackerspubcore");
    assert.equal(organization.inviterId, creator.account.id);
    assert.equal(organization.actor.type, "Organization");
    assert.equal(organization.actor.username, "hackerspubcore");

    const storedCreator = await tx.query.accountTable.findFirst({
      where: { id: creator.account.id },
    });
    assert.equal(storedCreator?.leftInvitations, 0);

    const membership = await tx.query.organizationMembershipTable.findFirst({
      where: {
        organizationAccountId: organization.id,
        memberAccountId: creator.account.id,
      },
    });
    assert.equal(membership?.role, "admin");
    assert.ok(membership?.accepted != null);
  });
});

test("createOrganization() rejects accounts without invitations", async () => {
  await withRollback(async (tx) => {
    const creator = await insertAccountWithActor(tx, {
      username: "noorginvite",
      name: "No Org Invite",
      email: "noorginvite@example.com",
    });

    await assert.rejects(
      createOrganization(createFedCtx(tx), creator.account, {
        username: "blockedorg",
        name: "Blocked Org",
        bio: "",
      }),
      /invitation/i,
    );

    const organization = await tx.query.accountTable.findFirst({
      where: { username: "blockedorg" },
    });
    assert.equal(organization, undefined);
  });
});

test("organization membership invite acceptance and last-member guard", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "orgadmin",
      name: "Org Admin",
      email: "orgadmin@example.com",
    });
    const member = await insertAccountWithActor(tx, {
      username: "orgmember",
      name: "Org Member",
      email: "orgmember@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "memberguardorg",
        name: "Member Guard Org",
        bio: "",
      },
    );

    await assert.rejects(
      leaveOrganization(tx, admin.account, organization.id),
      /last member/i,
    );

    const invitation = await inviteOrganizationMember(
      tx,
      admin.account,
      organization.id,
      member.account.username,
    );
    assert.equal(invitation.accepted, null);

    const accepted = await acceptOrganizationInvitation(
      tx,
      member.account,
      organization.id,
    );
    assert.ok(accepted.accepted != null);

    const left = await leaveOrganization(tx, member.account, organization.id);
    assert.equal(left.memberAccountId, member.account.id);

    const memberships = await tx.select()
      .from(organizationMembershipTable)
      .where(
        eq(organizationMembershipTable.organizationAccountId, organization.id),
      );
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].memberAccountId, admin.account.id);
  });
});

test("getOrganizationNotificationBadge() separates globally unread and member unread counts", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "badgeadmin",
      name: "Badge Admin",
      email: "badgeadmin@example.com",
    });
    const member = await insertAccountWithActor(tx, {
      username: "badgemember",
      name: "Badge Member",
      email: "badgemember@example.com",
    });
    const actor = await insertAccountWithActor(tx, {
      username: "badgeactor",
      name: "Badge Actor",
      email: "badgeactor@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "badgeorg",
        name: "Badge Org",
        bio: "",
      },
    );
    await inviteOrganizationMember(
      tx,
      admin.account,
      organization.id,
      member.account.username,
    );
    await acceptOrganizationInvitation(tx, member.account, organization.id);

    const created = [
      new Date("2026-04-15T09:00:00.000Z"),
      new Date("2026-04-15T08:00:00.000Z"),
      new Date("2026-04-15T07:00:00.000Z"),
    ];
    for (const [index, date] of created.entries()) {
      await tx.insert(notificationTable).values({
        id: crypto.randomUUID(),
        accountId: organization.id,
        type: "follow",
        actorIds: [actor.actor.id],
        created: date,
      }).onConflictDoNothing();
      if (index > 0) {
        await tx.execute(sql`select pg_sleep(0)`);
      }
    }

    await getOrganizationNotificationBadge(
      tx,
      organization.id,
      admin.account.id,
      created[1],
    );
    await getOrganizationNotificationBadge(
      tx,
      organization.id,
      member.account.id,
      created[2],
    );

    const redForAdmin = await getOrganizationNotificationBadge(
      tx,
      organization.id,
      admin.account.id,
    );
    assert.deepEqual(redForAdmin, { color: "red", count: 1 });

    await getOrganizationNotificationBadge(
      tx,
      organization.id,
      admin.account.id,
      created[0],
    );
    const noneForAdmin = await getOrganizationNotificationBadge(
      tx,
      organization.id,
      admin.account.id,
    );
    const grayForMember = await getOrganizationNotificationBadge(
      tx,
      organization.id,
      member.account.id,
    );
    assert.deepEqual(noneForAdmin, { color: null, count: 0 });
    assert.deepEqual(grayForMember, { color: "gray", count: 1 });
  });
});

test("acceptOrganizationConversion() preserves inviter and removes direct login email", async () => {
  await withRollback(async (tx) => {
    const inviter = await insertAccountWithActor(tx, {
      username: "conversioninviter",
      name: "Conversion Inviter",
      email: "conversioninviter@example.com",
    });
    const account = await insertAccountWithActor(tx, {
      username: "convertme",
      name: "Convert Me",
      email: "convertme@example.com",
    });
    const admin = await insertAccountWithActor(tx, {
      username: "conversionadmin",
      name: "Conversion Admin",
      email: "conversionadmin@example.com",
    });
    await tx.update(accountTable)
      .set({ inviterId: inviter.account.id })
      .where(eq(accountTable.id, account.account.id));

    const request = await requestOrganizationConversion(
      tx,
      account.account,
      admin.account.username,
      "convertme",
    );
    const converted = await acceptOrganizationConversion(
      createFedCtx(tx),
      admin.account,
      request.id,
    );

    assert.equal(converted.kind, "organization");
    assert.equal(converted.username, "convertme");
    assert.equal(converted.inviterId, inviter.account.id);
    assert.equal(converted.actor.type, "Organization");

    const emails = await tx.select()
      .from(accountEmailTable)
      .where(eq(accountEmailTable.accountId, converted.id));
    assert.equal(emails.length, 0);
  });
});

test("requestOrganizationConversion() notifies the accepting admin", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "conversionnotify",
      name: "Conversion Notify",
      email: "conversionnotify@example.com",
    });
    const admin = await insertAccountWithActor(tx, {
      username: "conversionnotifyadmin",
      name: "Conversion Notify Admin",
      email: "conversionnotifyadmin@example.com",
    });

    const first = await requestOrganizationConversion(
      tx,
      account.account,
      admin.account.username,
      account.account.username,
    );
    const second = await requestOrganizationConversion(
      tx,
      account.account,
      admin.account.username,
      account.account.username,
    );

    assert.equal(second.id, first.id);
    const notifications = await tx.query.notificationTable.findMany({
      where: {
        accountId: admin.account.id,
        type: "organization_conversion_request",
      },
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].organizationConversionRequestId, first.id);
    assert.deepEqual(notifications[0].actorIds, [account.actor.id]);
    assert.equal(notifications[0].postId, null);
  });
});

test("acceptOrganizationConversion() rejects accounts that still belong to organizations", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "conversionblockadmin",
      name: "Conversion Block Admin",
      email: "conversionblockadmin@example.com",
    });
    const member = await insertAccountWithActor(tx, {
      username: "conversionmember",
      name: "Conversion Member",
      email: "conversionmember@example.com",
    });
    const targetAdmin = await insertAccountWithActor(tx, {
      username: "conversiontargetadmin",
      name: "Conversion Target Admin",
      email: "conversiontargetadmin@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "conversionblockorg",
        name: "Conversion Block Org",
        bio: "",
      },
    );
    await inviteOrganizationMember(
      tx,
      admin.account,
      organization.id,
      member.account.username,
    );
    await acceptOrganizationInvitation(tx, member.account, organization.id);

    const request = await requestOrganizationConversion(
      tx,
      member.account,
      targetAdmin.account.username,
      member.account.username,
    );
    await assert.rejects(
      acceptOrganizationConversion(
        createFedCtx(tx),
        targetAdmin.account,
        request.id,
      ),
      /leave organizations/i,
    );

    const storedMember = await tx.query.accountTable.findFirst({
      where: { id: member.account.id },
    });
    assert.equal(storedMember?.kind, "personal");
  });
});
