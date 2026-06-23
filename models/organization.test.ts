import assert from "node:assert";
import test from "node:test";
import {
  exportJwk,
  generateCryptoKeyPair,
  MemoryKvStore,
  type MessageQueue,
} from "@fedify/fedify";
import { Organization, Update } from "@fedify/vocab";
import { eq, sql } from "drizzle-orm";
import { registerPushNotificationTarget } from "./push.ts";
import type { ContextData } from "./context.ts";
import {
  acceptOrganizationConversion,
  acceptOrganizationInvitation,
  createOrganization,
  ensureOrganizationInvitationNotifications,
  getOrganizationNotificationBadge,
  inviteOrganizationMember,
  LastOrganizationAdminError,
  leaveOrganization,
  removeOrganizationMember,
  requestOrganizationConversion,
} from "./organization.ts";
import {
  accountEmailTable,
  accountTable,
  actorTable,
  followingTable,
  invitationLinkTable,
  notificationTable,
  organizationMembershipTable,
  pushNotificationTargetTable,
} from "./schema.ts";
import {
  createFedCtx,
  createTestDisk,
  createTestKv,
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";
import type { Uuid } from "./uuid.ts";
import {
  setWebPushConfigForTesting,
  setWebPushSenderForTesting,
} from "./webpush.ts";

let federationBuilderPromise:
  | Promise<typeof import("../federation/mod.ts").builder>
  | undefined;

async function getFederationBuilder() {
  if (federationBuilderPromise == null) {
    federationBuilderPromise = (async () => {
      const { privateKey } = await generateCryptoKeyPair(
        "RSASSA-PKCS1-v1_5",
      );
      Deno.env.set(
        "INSTANCE_ACTOR_KEY",
        JSON.stringify(
          await exportJwk(privateKey),
        ),
      );
      return (await import("../federation/mod.ts")).builder;
    })();
  }
  return await federationBuilderPromise;
}

const validWebPushP256dh =
  "BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const validWebPushAuth = "AgICAgICAgICAgICAgICAg";

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

test("createOrganization() rejects invalid usernames without consuming invitations", async () => {
  await withRollback(async (tx) => {
    const creator = await insertAccountWithActor(tx, {
      username: "invalidorgcreator",
      name: "Invalid Org Creator",
      email: "invalidorgcreator@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, creator.account.id));

    await assert.rejects(
      createOrganization(createFedCtx(tx), creator.account, {
        username: "bad-org!",
        name: "Bad Org",
        bio: "",
      }),
      /username/i,
    );

    const storedCreator = await tx.query.accountTable.findFirst({
      where: { id: creator.account.id },
    });
    assert.equal(storedCreator?.leftInvitations, 1);
    const organization = await tx.query.accountTable.findFirst({
      where: { username: "bad-org!" },
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

test("inviteOrganizationMember() notifies the invited account", async () => {
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
    await withRollback(async (tx) => {
      const admin = await insertAccountWithActor(tx, {
        username: "notifyinviteadmin",
        name: "Notify Invite Admin",
        email: "notifyinviteadmin@example.com",
      });
      const member = await insertAccountWithActor(tx, {
        username: "notifyinvitemember",
        name: "Notify Invite Member",
        email: "notifyinvitemember@example.com",
      });
      await registerPushNotificationTarget(tx, member.account.id, {
        service: "web_push",
        subscription: {
          endpoint: "https://push.example/org-invitation",
          p256dh: validWebPushP256dh,
          auth: validWebPushAuth,
        },
      });
      await tx.update(accountTable)
        .set({ leftInvitations: 1 })
        .where(eq(accountTable.id, admin.account.id));
      const organization = await createOrganization(
        createFedCtx(tx),
        admin.account,
        {
          username: "notifyinviteorg",
          name: "Notify Invite Org",
          bio: "",
        },
      );

      await inviteOrganizationMember(
        tx,
        admin.account,
        organization.id,
        member.account.username,
      );
      await inviteOrganizationMember(
        tx,
        admin.account,
        organization.id,
        member.account.username,
      );

      const notifications = await tx.query.notificationTable.findMany({
        where: {
          accountId: member.account.id,
          type: "organization_invitation",
        },
      });
      assert.equal(notifications.length, 1);
      assert.deepEqual(notifications[0].actorIds, [organization.actor.id]);
      assert.equal(notifications[0].postId, null);
      assert.equal(notifications[0].organizationConversionRequestId, null);
      assert.equal(sent.length, 1);
      assert.equal(
        JSON.parse(sent[0].payload).data.notificationId,
        notifications[0].id,
      );
    });
  } finally {
    setWebPushConfigForTesting(undefined);
    setWebPushSenderForTesting(undefined);
  }
});

test("inviteOrganizationMember() recreates stale invitation notifications", async () => {
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
    await withRollback(async (tx) => {
      const admin = await insertAccountWithActor(tx, {
        username: "reinviteadmin",
        name: "Reinvite Admin",
        email: "reinviteadmin@example.com",
      });
      const member = await insertAccountWithActor(tx, {
        username: "reinvitemember",
        name: "Reinvite Member",
        email: "reinvitemember@example.com",
      });
      await registerPushNotificationTarget(tx, member.account.id, {
        service: "web_push",
        subscription: {
          endpoint: "https://push.example/org-reinvitation",
          p256dh: validWebPushP256dh,
          auth: validWebPushAuth,
        },
      });
      await tx.update(accountTable)
        .set({ leftInvitations: 1 })
        .where(eq(accountTable.id, admin.account.id));
      const organization = await createOrganization(
        createFedCtx(tx),
        admin.account,
        {
          username: "reinviteorg",
          name: "Reinvite Org",
          bio: "",
        },
      );

      await inviteOrganizationMember(
        tx,
        admin.account,
        organization.id,
        member.account.username,
      );
      const firstNotification = await tx.query.notificationTable.findFirst({
        where: {
          accountId: member.account.id,
          type: "organization_invitation",
        },
      });
      assert.ok(firstNotification != null);
      assert.equal(sent.length, 1);

      await acceptOrganizationInvitation(tx, member.account, organization.id);
      await removeOrganizationMember(
        tx,
        admin.account,
        organization.id,
        member.account.id,
      );

      await inviteOrganizationMember(
        tx,
        admin.account,
        organization.id,
        member.account.username,
      );

      const notifications = await tx.query.notificationTable.findMany({
        where: {
          accountId: member.account.id,
          type: "organization_invitation",
        },
      });
      assert.equal(notifications.length, 1);
      assert.notEqual(notifications[0].id, firstNotification.id);
      assert.deepEqual(notifications[0].actorIds, [organization.actor.id]);
      assert.equal(sent.length, 2);
      assert.equal(
        JSON.parse(sent[1].payload).data.notificationId,
        notifications[0].id,
      );

      const membership = await tx.query.organizationMembershipTable.findFirst({
        where: {
          organizationAccountId: organization.id,
          memberAccountId: member.account.id,
        },
      });
      assert.equal(membership?.accepted, null);
    });
  } finally {
    setWebPushConfigForTesting(undefined);
    setWebPushSenderForTesting(undefined);
  }
});

test("ensureOrganizationInvitationNotifications() repairs pending invitations", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "repairinviteadmin",
      name: "Repair Invite Admin",
      email: "repairinviteadmin@example.com",
    });
    const member = await insertAccountWithActor(tx, {
      username: "repairinvitemember",
      name: "Repair Invite Member",
      email: "repairinvitemember@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "repairinviteorg",
        name: "Repair Invite Org",
        bio: "",
      },
    );
    await tx.insert(organizationMembershipTable).values({
      organizationAccountId: organization.id,
      memberAccountId: member.account.id,
      role: "member",
      invitedById: admin.account.id,
    });

    await ensureOrganizationInvitationNotifications(tx, member.account.id);
    await ensureOrganizationInvitationNotifications(tx, member.account.id);

    const notifications = await tx.query.notificationTable.findMany({
      where: {
        accountId: member.account.id,
        type: "organization_invitation",
      },
    });
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].actorIds, [organization.actor.id]);
    assert.equal(notifications[0].postId, null);
    assert.equal(notifications[0].organizationConversionRequestId, null);
  });
});

test("removeOrganizationMember() cancels a pending invitation", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "cancelinviteadmin",
      name: "Cancel Invite Admin",
      email: "cancelinviteadmin@example.com",
    });
    const member = await insertAccountWithActor(tx, {
      username: "cancelinvitemember",
      name: "Cancel Invite Member",
      email: "cancelinvitemember@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "cancelinviteorg",
        name: "Cancel Invite Org",
        bio: "",
      },
    );
    await inviteOrganizationMember(
      tx,
      admin.account,
      organization.id,
      member.account.username,
    );

    const removed = await removeOrganizationMember(
      tx,
      admin.account,
      organization.id,
      member.account.id,
    );

    assert.equal(removed.memberAccountId, member.account.id);
    assert.equal(removed.accepted, null);
    const remaining = await tx.query.organizationMembershipTable.findFirst({
      where: {
        organizationAccountId: organization.id,
        memberAccountId: member.account.id,
      },
    });
    assert.equal(remaining, undefined);
    const notifications = await tx.query.notificationTable.findMany({
      where: {
        accountId: member.account.id,
        type: "organization_invitation",
      },
    });
    assert.equal(notifications.length, 0);
  });
});

test("removeOrganizationMember() rejects removing the last accepted admin", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "lastremoveadmin",
      name: "Last Remove Admin",
      email: "lastremoveadmin@example.com",
    });
    const member = await insertAccountWithActor(tx, {
      username: "lastremovemember",
      name: "Last Remove Member",
      email: "lastremovemember@example.com",
    });
    const pendingAdmin = await insertAccountWithActor(tx, {
      username: "lastremovepending",
      name: "Last Remove Pending",
      email: "lastremovepending@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "lastremoveorg",
        name: "Last Remove Org",
        bio: "",
      },
    );
    await tx.insert(organizationMembershipTable).values([
      {
        organizationAccountId: organization.id,
        memberAccountId: member.account.id,
        role: "member",
        invitedById: admin.account.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      },
      {
        organizationAccountId: organization.id,
        memberAccountId: pendingAdmin.account.id,
        role: "admin",
        invitedById: admin.account.id,
      },
    ]);

    await assert.rejects(
      removeOrganizationMember(
        tx,
        admin.account,
        organization.id,
        admin.account.id,
      ),
      (error) =>
        error instanceof LastOrganizationAdminError &&
        /removed/i.test(error.message),
    );
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

test("getOrganizationNotificationBadge() ignores notifications with no visible actors", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "hiddenbadgeadmin",
      name: "Hidden Badge Admin",
      email: "hiddenbadgeadmin@example.com",
    });
    const member = await insertAccountWithActor(tx, {
      username: "hiddenbadgemember",
      name: "Hidden Badge Member",
      email: "hiddenbadgemember@example.com",
    });
    const actor = await insertAccountWithActor(tx, {
      username: "hiddenbadgeactor",
      name: "Hidden Badge Actor",
      email: "hiddenbadgeactor@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "hiddenbadgeorg",
        name: "Hidden Badge Org",
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

    await tx.insert(notificationTable).values({
      id: crypto.randomUUID(),
      accountId: organization.id,
      type: "follow",
      actorIds: [actor.actor.id],
      created: new Date("2026-04-15T09:00:00.000Z"),
    });
    await tx.delete(actorTable).where(eq(actorTable.id, actor.actor.id));

    const unread = await getOrganizationNotificationBadge(
      tx,
      organization.id,
      admin.account.id,
    );
    assert.deepEqual(unread, { color: null, count: 0 });

    await getOrganizationNotificationBadge(
      tx,
      organization.id,
      member.account.id,
      new Date("2026-04-15T10:00:00.000Z"),
    );
    const readByOtherMember = await getOrganizationNotificationBadge(
      tx,
      organization.id,
      admin.account.id,
    );
    assert.deepEqual(readByOtherMember, { color: null, count: 0 });
  });
});

test("getOrganizationNotificationBadge() ignores former-member read markers", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "formerreadadmin",
      name: "Former Read Admin",
      email: "formerreadadmin@example.com",
    });
    const currentMember = await insertAccountWithActor(tx, {
      username: "formerreadcurrent",
      name: "Former Read Current",
      email: "formerreadcurrent@example.com",
    });
    const formerMember = await insertAccountWithActor(tx, {
      username: "formerreader",
      name: "Former Reader",
      email: "formerreader@example.com",
    });
    const actor = await insertAccountWithActor(tx, {
      username: "formerreadactor",
      name: "Former Read Actor",
      email: "formerreadactor@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "formerreadorg",
        name: "Former Read Org",
        bio: "",
      },
    );
    for (const member of [currentMember, formerMember]) {
      await inviteOrganizationMember(
        tx,
        admin.account,
        organization.id,
        member.account.username,
      );
      await acceptOrganizationInvitation(tx, member.account, organization.id);
    }

    const created = new Date("2026-04-15T09:00:00.000Z");
    await tx.insert(notificationTable).values({
      id: crypto.randomUUID(),
      accountId: organization.id,
      type: "follow",
      actorIds: [actor.actor.id],
      created,
    });
    await getOrganizationNotificationBadge(
      tx,
      organization.id,
      formerMember.account.id,
      new Date("2026-04-15T10:00:00.000Z"),
    );
    await removeOrganizationMember(
      tx,
      admin.account,
      organization.id,
      formerMember.account.id,
    );

    const badge = await getOrganizationNotificationBadge(
      tx,
      organization.id,
      currentMember.account.id,
    );
    assert.deepEqual(badge, { color: "red", count: 1 });
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
    await tx.insert(pushNotificationTargetTable).values({
      id: crypto.randomUUID(),
      accountId: account.account.id,
      service: "fcm",
      token: "converted-account-fcm-token",
    });
    await tx.insert(invitationLinkTable).values({
      id: crypto.randomUUID() as Uuid,
      inviterId: account.account.id,
      invitationsLeft: 3,
      message: "Join with a stale conversion link",
    });
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

    const pushTargets = await tx.select()
      .from(pushNotificationTargetTable)
      .where(eq(pushNotificationTargetTable.accountId, converted.id));
    assert.equal(pushTargets.length, 0);

    const invitationLinks = await tx.select()
      .from(invitationLinkTable)
      .where(eq(invitationLinkTable.inviterId, converted.id));
    assert.equal(invitationLinks.length, 0);
  });
});

test("acceptOrganizationConversion() sends Update(Organization) to followers", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "convertfederate",
      name: "Convert Federate",
      email: "convertfederate@example.com",
    });
    const admin = await insertAccountWithActor(tx, {
      username: "convertfederateadmin",
      name: "Convert Federate Admin",
      email: "convertfederateadmin@example.com",
    });
    const request = await requestOrganizationConversion(
      tx,
      account.account,
      admin.account.username,
      account.account.username,
    );
    const baseFedCtx = createFedCtx(tx);
    const sent: { recipient: unknown; activity: unknown }[] = [];
    const fedCtx = {
      ...baseFedCtx,
      async getActor(identifier: string) {
        const stored = await tx.query.accountTable.findFirst({
          where: { id: identifier as Uuid },
        });
        assert.ok(stored != null);
        assert.equal(stored?.kind, "organization");
        return new Organization({
          id: baseFedCtx.getActorUri(identifier),
          preferredUsername: stored.username,
        });
      },
      sendActivity(_sender: unknown, recipient: unknown, activity: unknown) {
        sent.push({ recipient, activity });
        return Promise.resolve(undefined);
      },
    } as typeof baseFedCtx;

    await acceptOrganizationConversion(fedCtx, admin.account, request.id);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].recipient, "followers");
    const activity = sent[0].activity;
    assert.ok(activity instanceof Update);
    assert.equal(
      activity.actorId?.href,
      fedCtx.getActorUri(account.account.id).href,
    );
    const object = await activity.getObject({
      ...fedCtx,
      suppressError: true,
    });
    assert.ok(object instanceof Organization);
    assert.equal(object.id?.href, fedCtx.getActorUri(account.account.id).href);
  });
});

test("acceptOrganizationConversion() enqueues Update(Organization) through Fedify", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "convertfedify",
      name: "Convert Fedify",
      email: "convertfedify@example.com",
    });
    const admin = await insertAccountWithActor(tx, {
      username: "convertfedifyadmin",
      name: "Convert Fedify Admin",
      email: "convertfedifyadmin@example.com",
    });
    const follower = await insertRemoteActor(tx, {
      username: "convertfedifyfollower",
      name: "Convert Fedify Follower",
      host: "remote.example",
    });
    await tx.insert(followingTable).values({
      iri: "https://remote.example/follows/convert-fedify",
      followerId: follower.id,
      followeeId: account.actor.id,
      accepted: new Date("2026-04-15T00:00:00.000Z"),
    });
    const request = await requestOrganizationConversion(
      tx,
      account.account,
      admin.account.username,
      account.account.username,
    );
    const queued: unknown[] = [];
    const queue: MessageQueue = {
      enqueue(message) {
        queued.push(message);
        return Promise.resolve();
      },
      enqueueMany(messages) {
        queued.push(...messages);
        return Promise.resolve();
      },
      listen() {
        return new Promise(() => {});
      },
    };
    const builder = await getFederationBuilder();
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      queue,
      manuallyStartQueue: true,
      origin: "http://localhost/",
    });
    const { kv } = createTestKv();
    const fedCtx = federation.createContext(
      new Request("http://localhost/graphql"),
      {
        db: tx,
        kv,
        disk: createTestDisk(),
        models: {} as ContextData["models"],
      },
    );

    await acceptOrganizationConversion(fedCtx, admin.account, request.id);

    assert.equal(queued.length, 1);
  });
});

test("requestOrganizationConversion() notifies the accepting admin", async () => {
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
      await registerPushNotificationTarget(tx, admin.account.id, {
        service: "web_push",
        subscription: {
          endpoint: "https://push.example/org-conversion",
          p256dh: validWebPushP256dh,
          auth: validWebPushAuth,
        },
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
      assert.equal(sent.length, 1);
      assert.equal(
        JSON.parse(sent[0].payload).data.notificationId,
        notifications[0].id,
      );
    });
  } finally {
    setWebPushConfigForTesting(undefined);
    setWebPushSenderForTesting(undefined);
  }
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
