import type { Context, RequestContext } from "@fedify/fedify";
import { and, count, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { isUsernameReserved, sendAccountActorUpdate } from "./account.ts";
import { syncActorFromAccount } from "./actor.ts";
import type { ContextData } from "./context.ts";
import type { Database, Transaction } from "./db.ts";
import {
  createOrganizationConversionRequestNotification
    as createOrganizationConversionRequestNotificationRow,
  createOrganizationInvitationNotification
    as createOrganizationInvitationNotificationRow,
} from "./notification.ts";
import {
  type Account,
  type AccountEmail,
  accountEmailTable,
  type AccountLink,
  accountTable,
  type Actor,
  actorTable,
  invitationLinkTable,
  type Medium,
  notificationTable,
  type OrganizationConversionRequest,
  organizationConversionRequestTable,
  type OrganizationMemberRole,
  type OrganizationMembership,
  organizationMembershipTable,
  organizationNotificationReadTable,
  organizationPostAuthorTable,
  passkeyTable,
  pushNotificationTargetTable,
} from "./schema.ts";
import {
  validateBio,
  validateDisplayName,
  validateUsername,
} from "./userValidation.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

export class OrganizationInvitationRequiredError extends Error {
  constructor() {
    super("An invitation is required to create an organization.");
    this.name = "OrganizationInvitationRequiredError";
  }
}

export class OrganizationPermissionError extends Error {
  constructor() {
    super("The account is not allowed to manage this organization.");
    this.name = "OrganizationPermissionError";
  }
}

export class OrganizationMembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationMembershipError";
  }
}

export class LastOrganizationMemberError extends OrganizationMembershipError {
  constructor() {
    super("The last member cannot leave the organization.");
    this.name = "LastOrganizationMemberError";
  }
}

export class LastOrganizationAdminError extends OrganizationMembershipError {
  constructor() {
    super("The last admin cannot leave, be removed, or be demoted.");
    this.name = "LastOrganizationAdminError";
  }
}

export class OrganizationConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationConversionError";
  }
}

export interface CreateOrganizationInput {
  username: string;
  name: string;
  bio: string;
}

export interface OrganizationNotificationBadge {
  color: "red" | "gray" | null;
  count: number;
}

export type AccountWithActor = Account & {
  actor: Actor;
  avatarMedium?: Medium | null;
  emails?: AccountEmail[];
  links?: AccountLink[];
};

interface OrganizationInvitationNotificationOptions {
  forceFresh?: boolean;
}

type AccountForSync = Account & {
  avatarMedium: Medium | null;
  emails: AccountEmail[];
  links: AccountLink[];
};

function isTransaction(db: Database | Transaction): db is Transaction {
  return "rollback" in db;
}

async function runInTransaction<T>(
  db: Database | Transaction,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (isTransaction(db)) return await run(db);
  return await db.transaction(run);
}

function asTransactionalFedCtx(
  fedCtx: Context<ContextData>,
  tx: Transaction,
): Context<ContextData> {
  return fedCtx.clone({
    ...fedCtx.data,
    db: tx,
  });
}

async function lockOrganizationMembershipSet(
  tx: Transaction,
  organizationAccountId: Uuid,
): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`organization-membership:${organizationAccountId}`}, 0)
    )
  `);
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

async function loadAccountForSync(
  db: Database | Transaction,
  accountId: Uuid,
): Promise<AccountForSync> {
  const account = await db.query.accountTable.findFirst({
    where: { id: accountId },
    with: {
      avatarMedium: true,
      emails: true,
      links: true,
    },
  });
  if (account == null) {
    throw new OrganizationMembershipError("The account does not exist.");
  }
  return account;
}

async function loadAccountWithActor(
  db: Database | Transaction,
  accountId: Uuid,
): Promise<
  Account & {
    actor: Actor;
    avatarMedium: Medium | null;
    emails: AccountEmail[];
    links: AccountLink[];
  }
> {
  const account = await db.query.accountTable.findFirst({
    where: { id: accountId },
    with: {
      actor: true,
      avatarMedium: true,
      emails: true,
      links: true,
    },
  });
  if (account == null) {
    throw new OrganizationMembershipError("The account does not exist.");
  }
  return account;
}

async function getAcceptedMembership(
  db: Database | Transaction,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
): Promise<OrganizationMembership | undefined> {
  return await db.query.organizationMembershipTable.findFirst({
    where: {
      organizationAccountId,
      memberAccountId,
      accepted: { isNotNull: true },
    },
  });
}

async function assertOrganizationAdmin(
  db: Database | Transaction,
  adminAccount: Pick<Account, "id" | "kind">,
  organizationAccountId: Uuid,
): Promise<OrganizationMembership> {
  if (adminAccount.kind !== "personal") {
    throw new OrganizationPermissionError();
  }
  const membership = await getAcceptedMembership(
    db,
    organizationAccountId,
    adminAccount.id,
  );
  if (membership == null || membership.role !== "admin") {
    throw new OrganizationPermissionError();
  }
  return membership;
}

async function countAcceptedMembers(
  db: Database | Transaction,
  organizationAccountId: Uuid,
): Promise<number> {
  const rows = await db.select({ count: count() })
    .from(organizationMembershipTable)
    .where(and(
      eq(
        organizationMembershipTable.organizationAccountId,
        organizationAccountId,
      ),
      isNotNull(organizationMembershipTable.accepted),
    ));
  return Number(rows[0]?.count ?? 0);
}

async function countAcceptedAdmins(
  db: Database | Transaction,
  organizationAccountId: Uuid,
): Promise<number> {
  const rows = await db.select({ count: count() })
    .from(organizationMembershipTable)
    .where(and(
      eq(
        organizationMembershipTable.organizationAccountId,
        organizationAccountId,
      ),
      eq(organizationMembershipTable.role, "admin"),
      isNotNull(organizationMembershipTable.accepted),
    ));
  return Number(rows[0]?.count ?? 0);
}

export async function assertPersonalAccountDeletionPreservesOrganizations(
  db: Database | Transaction,
  accountId: Uuid,
): Promise<void> {
  await runInTransaction(db, async (tx) => {
    const initialMemberships = await tx.query.organizationMembershipTable
      .findMany({
        where: {
          memberAccountId: accountId,
          accepted: { isNotNull: true },
        },
        columns: {
          organizationAccountId: true,
        },
      });
    const organizationAccountIds = [
      ...new Set(
        initialMemberships.map((membership) =>
          membership.organizationAccountId
        ),
      ),
    ].sort();
    for (const organizationAccountId of organizationAccountIds) {
      await lockOrganizationMembershipSet(tx, organizationAccountId);
    }
    const memberships = await tx.query.organizationMembershipTable.findMany({
      where: {
        memberAccountId: accountId,
        accepted: { isNotNull: true },
      },
      columns: {
        organizationAccountId: true,
        role: true,
      },
    });
    for (const membership of memberships) {
      const members = await countAcceptedMembers(
        tx,
        membership.organizationAccountId,
      );
      if (members <= 1) throw new LastOrganizationMemberError();
      if (membership.role === "admin") {
        const admins = await countAcceptedAdmins(
          tx,
          membership.organizationAccountId,
        );
        if (admins <= 1) throw new LastOrganizationAdminError();
      }
    }
  });
}

export async function createOrganization(
  fedCtx: Context<ContextData>,
  creator: Pick<Account, "id" | "kind">,
  input: CreateOrganizationInput,
): Promise<
  Account & {
    actor: Actor;
    avatarMedium: Medium | null;
    emails: AccountEmail[];
    links: AccountLink[];
  }
> {
  if (creator.kind !== "personal") {
    throw new OrganizationInvitationRequiredError();
  }
  const username = normalizeUsername(input.username);
  if (validateUsername(username) != null) {
    throw new OrganizationMembershipError(
      "The organization username is invalid.",
    );
  }
  const db = fedCtx.data.db;
  if (await isUsernameReserved(db, username)) {
    throw new OrganizationMembershipError(
      "The organization username is already in use.",
    );
  }
  const name = input.name.trim();
  if (validateDisplayName(name) != null) {
    throw new OrganizationMembershipError(
      "The organization display name is invalid.",
    );
  }
  if (validateBio(input.bio) != null) {
    throw new OrganizationMembershipError(
      "The organization bio is invalid.",
    );
  }
  return await runInTransaction(db, async (tx) => {
    const creatorRows = await tx.update(accountTable)
      .set({
        leftInvitations: sql`${accountTable.leftInvitations} - 1`,
        updated: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(
        eq(accountTable.id, creator.id),
        eq(accountTable.kind, "personal"),
        gt(accountTable.leftInvitations, 0),
      ))
      .returning({ id: accountTable.id });
    if (creatorRows.length < 1) {
      throw new OrganizationInvitationRequiredError();
    }

    const organizationId = generateUuidV7();
    const organizations = await tx.insert(accountTable).values({
      id: organizationId,
      kind: "organization",
      username,
      name,
      bio: input.bio,
      leftInvitations: 0,
      inviterId: creator.id,
    }).onConflictDoNothing().returning();
    if (organizations.length < 1) {
      throw new OrganizationMembershipError(
        "The organization username is already in use.",
      );
    }

    await tx.insert(organizationMembershipTable).values({
      organizationAccountId: organizationId,
      memberAccountId: creator.id,
      role: "admin",
      invitedById: creator.id,
      accepted: sql`CURRENT_TIMESTAMP`,
    });

    const txFedCtx = asTransactionalFedCtx(fedCtx, tx);
    const organization = await loadAccountForSync(tx, organizationId);
    const actor = await syncActorFromAccount(txFedCtx, organization);
    return { ...organization, actor };
  });
}

export async function inviteOrganizationMember(
  db: Database | Transaction,
  adminAccount: Pick<Account, "id" | "kind">,
  organizationAccountId: Uuid,
  memberUsername: string,
  role: OrganizationMemberRole = "member",
): Promise<OrganizationMembership> {
  await assertOrganizationAdmin(db, adminAccount, organizationAccountId);
  const organization = await db.query.accountTable.findFirst({
    where: { id: organizationAccountId },
    columns: { id: true, kind: true },
  });
  if (organization?.kind !== "organization") {
    throw new OrganizationMembershipError("The organization does not exist.");
  }
  const member = await db.query.accountTable.findFirst({
    where: {
      username: normalizeUsername(memberUsername),
      kind: "personal",
    },
    columns: { id: true },
  });
  if (member == null) {
    throw new OrganizationMembershipError(
      "The invited account does not exist.",
    );
  }
  const rows = await db.insert(organizationMembershipTable).values({
    organizationAccountId,
    memberAccountId: member.id,
    role,
    invitedById: adminAccount.id,
  }).onConflictDoNothing().returning();
  const membership = rows[0] ??
    await db.query.organizationMembershipTable.findFirst({
      where: { organizationAccountId, memberAccountId: member.id },
    });
  if (membership == null) {
    throw new OrganizationMembershipError("Failed to invite member.");
  }
  if (membership.accepted == null) {
    await createOrganizationInvitationNotification(
      db,
      organizationAccountId,
      member.id,
      { forceFresh: rows[0] != null },
    );
  }
  return membership;
}

export async function ensureOrganizationInvitationNotifications(
  db: Database | Transaction,
  memberAccountId: Uuid,
): Promise<void> {
  await runInTransaction(db, async (tx) => {
    const memberships = await tx.query.organizationMembershipTable.findMany({
      where: {
        memberAccountId,
        accepted: { isNull: true },
      },
      columns: { organizationAccountId: true },
    });
    for (const membership of memberships) {
      await createOrganizationInvitationNotification(
        tx,
        membership.organizationAccountId,
        memberAccountId,
      );
    }
  });
}

async function createOrganizationInvitationNotification(
  db: Database | Transaction,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
  options: OrganizationInvitationNotificationOptions = {},
): Promise<void> {
  await runInTransaction(db, async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${organizationAccountId}:${memberAccountId}`}, 0)
      )
    `);
    const actor = await tx.query.actorTable.findFirst({
      where: { accountId: organizationAccountId },
      columns: { id: true },
    });
    if (actor == null) {
      throw new OrganizationMembershipError(
        "The organization actor does not exist.",
      );
    }
    if (options.forceFresh === true) {
      await deleteOrganizationInvitationNotification(
        tx,
        organizationAccountId,
        memberAccountId,
      );
    }
    await createOrganizationInvitationNotificationRow(
      tx,
      memberAccountId,
      actor.id,
    );
  });
}

export async function acceptOrganizationInvitation(
  db: Database | Transaction,
  memberAccount: Pick<Account, "id" | "kind">,
  organizationAccountId: Uuid,
): Promise<OrganizationMembership> {
  if (memberAccount.kind !== "personal") {
    throw new OrganizationMembershipError("Only personal accounts can join.");
  }
  const rows = await db.update(organizationMembershipTable)
    .set({
      accepted: sql`CURRENT_TIMESTAMP`,
      updated: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(
      eq(
        organizationMembershipTable.organizationAccountId,
        organizationAccountId,
      ),
      eq(organizationMembershipTable.memberAccountId, memberAccount.id),
      isNull(organizationMembershipTable.accepted),
    ))
    .returning();
  if (rows[0] != null) return rows[0];
  const existing = await getAcceptedMembership(
    db,
    organizationAccountId,
    memberAccount.id,
  );
  if (existing == null) {
    throw new OrganizationMembershipError("The invitation does not exist.");
  }
  return existing;
}

export async function updateOrganizationMemberRole(
  db: Database | Transaction,
  adminAccount: Pick<Account, "id" | "kind">,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
  role: OrganizationMemberRole,
): Promise<OrganizationMembership> {
  return await runInTransaction(db, async (tx) => {
    await lockOrganizationMembershipSet(tx, organizationAccountId);
    await assertOrganizationAdmin(tx, adminAccount, organizationAccountId);
    const membership = await getAcceptedMembership(
      tx,
      organizationAccountId,
      memberAccountId,
    );
    if (membership == null) {
      throw new OrganizationMembershipError("The member does not exist.");
    }
    if (membership.role === "admin" && role === "member") {
      const admins = await countAcceptedAdmins(tx, organizationAccountId);
      if (admins <= 1) throw new LastOrganizationAdminError();
    }
    const rows = await tx.update(organizationMembershipTable)
      .set({ role, updated: sql`CURRENT_TIMESTAMP` })
      .where(and(
        eq(
          organizationMembershipTable.organizationAccountId,
          organizationAccountId,
        ),
        eq(organizationMembershipTable.memberAccountId, memberAccountId),
      ))
      .returning();
    return rows[0]!;
  });
}

export async function removeOrganizationMember(
  db: Database | Transaction,
  adminAccount: Pick<Account, "id" | "kind">,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
): Promise<OrganizationMembership> {
  return await runInTransaction(db, async (tx) => {
    await lockOrganizationMembershipSet(tx, organizationAccountId);
    await assertOrganizationAdmin(tx, adminAccount, organizationAccountId);
    const membership = await tx.query.organizationMembershipTable.findFirst({
      where: { organizationAccountId, memberAccountId },
    });
    if (membership == null) {
      throw new OrganizationMembershipError("The member does not exist.");
    }
    if (membership.accepted == null) {
      const rows = await tx.delete(organizationMembershipTable)
        .where(and(
          eq(
            organizationMembershipTable.organizationAccountId,
            organizationAccountId,
          ),
          eq(organizationMembershipTable.memberAccountId, memberAccountId),
          isNull(organizationMembershipTable.accepted),
        ))
        .returning();
      const removed = rows[0];
      if (removed == null) {
        throw new OrganizationMembershipError(
          "The invitation does not exist.",
        );
      }
      await deleteOrganizationInvitationNotification(
        tx,
        organizationAccountId,
        memberAccountId,
      );
      return removed;
    }
    return await removeAcceptedMembership(
      tx,
      organizationAccountId,
      memberAccountId,
    );
  });
}

async function deleteOrganizationInvitationNotification(
  db: Database | Transaction,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
): Promise<void> {
  const actor = await db.query.actorTable.findFirst({
    where: { accountId: organizationAccountId },
    columns: { id: true },
  });
  if (actor == null) return;
  await db.delete(notificationTable)
    .where(sql`
      ${notificationTable.accountId} = ${memberAccountId}
      AND ${notificationTable.type} = 'organization_invitation'
      AND ${notificationTable.actorIds} = ARRAY[${actor.id}]::uuid[]
    `);
}

export async function leaveOrganization(
  db: Database | Transaction,
  memberAccount: Pick<Account, "id" | "kind">,
  organizationAccountId: Uuid,
): Promise<OrganizationMembership> {
  if (memberAccount.kind !== "personal") {
    throw new OrganizationMembershipError("Only personal accounts can leave.");
  }
  return await removeAcceptedMembership(
    db,
    organizationAccountId,
    memberAccount.id,
  );
}

async function removeAcceptedMembership(
  db: Database | Transaction,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
): Promise<OrganizationMembership> {
  return await runInTransaction(db, async (tx) => {
    await lockOrganizationMembershipSet(tx, organizationAccountId);
    const membership = await getAcceptedMembership(
      tx,
      organizationAccountId,
      memberAccountId,
    );
    if (membership == null) {
      throw new OrganizationMembershipError("The member does not exist.");
    }
    const members = await countAcceptedMembers(tx, organizationAccountId);
    if (members <= 1) throw new LastOrganizationMemberError();
    if (membership.role === "admin") {
      const admins = await countAcceptedAdmins(tx, organizationAccountId);
      if (admins <= 1) throw new LastOrganizationAdminError();
    }
    const rows = await tx.delete(organizationMembershipTable)
      .where(and(
        eq(
          organizationMembershipTable.organizationAccountId,
          organizationAccountId,
        ),
        eq(organizationMembershipTable.memberAccountId, memberAccountId),
        isNotNull(organizationMembershipTable.accepted),
      ))
      .returning();
    const removed = rows[0];
    if (removed == null) {
      throw new OrganizationMembershipError("The member does not exist.");
    }
    await tx.delete(organizationNotificationReadTable)
      .where(and(
        eq(
          organizationNotificationReadTable.organizationAccountId,
          organizationAccountId,
        ),
        eq(organizationNotificationReadTable.memberAccountId, memberAccountId),
      ));
    return removed;
  });
}

export async function requestOrganizationConversion(
  db: Database | Transaction,
  account: Pick<Account, "id" | "kind" | "username">,
  adminUsername: string,
  confirmationUsername: string,
): Promise<OrganizationConversionRequest> {
  if (account.kind !== "personal") {
    throw new OrganizationConversionError(
      "Only personal accounts can convert.",
    );
  }
  if (confirmationUsername !== account.username) {
    throw new OrganizationConversionError("The username confirmation failed.");
  }
  const admin = await db.query.accountTable.findFirst({
    where: {
      username: normalizeUsername(adminUsername),
      kind: "personal",
    },
    columns: { id: true },
  });
  if (admin == null || admin.id === account.id) {
    throw new OrganizationConversionError("The admin account is invalid.");
  }
  const pending = await db.query.organizationConversionRequestTable.findFirst({
    where: {
      accountId: account.id,
      accepted: { isNull: true },
    },
  });
  if (pending != null) {
    await createOrganizationConversionRequestNotification(
      db,
      account.id,
      pending.adminAccountId,
      pending.id,
    );
    return pending;
  }
  const rows = await db.insert(organizationConversionRequestTable).values({
    id: generateUuidV7(),
    accountId: account.id,
    adminAccountId: admin.id,
  }).returning();
  const request = rows[0];
  await createOrganizationConversionRequestNotification(
    db,
    account.id,
    request.adminAccountId,
    request.id,
  );
  return request;
}

async function createOrganizationConversionRequestNotification(
  db: Database | Transaction,
  accountId: Uuid,
  adminAccountId: Uuid,
  requestId: Uuid,
): Promise<void> {
  const actor = await db.query.actorTable.findFirst({
    where: { accountId },
    columns: { id: true },
  });
  if (actor == null) {
    throw new OrganizationConversionError("The converting account is invalid.");
  }
  await createOrganizationConversionRequestNotificationRow(
    db,
    adminAccountId,
    actor.id,
    requestId,
  );
}

export async function acceptOrganizationConversion(
  fedCtx: RequestContext<ContextData>,
  adminAccount: Pick<Account, "id" | "kind">,
  requestId: Uuid,
): Promise<
  Account & {
    actor: Actor;
    avatarMedium: Medium | null;
    emails: AccountEmail[];
    links: AccountLink[];
  }
> {
  if (adminAccount.kind !== "personal") {
    throw new OrganizationConversionError("Only personal accounts can accept.");
  }
  const db = fedCtx.data.db;
  const organization = await runInTransaction(db, async (tx) => {
    const request = await tx.query.organizationConversionRequestTable.findFirst(
      {
        where: {
          id: requestId,
          adminAccountId: adminAccount.id,
          accepted: { isNull: true },
        },
        with: {
          account: {
            with: {
              avatarMedium: true,
              emails: true,
              links: true,
            },
          },
        },
      },
    );
    if (request == null || request.account.kind !== "personal") {
      throw new OrganizationConversionError(
        "The conversion request is invalid.",
      );
    }
    const existingMemberships = await tx.select({
      organizationAccountId: organizationMembershipTable.organizationAccountId,
    })
      .from(organizationMembershipTable)
      .where(and(
        eq(organizationMembershipTable.memberAccountId, request.accountId),
        isNotNull(organizationMembershipTable.accepted),
      ))
      .limit(1);
    if (existingMemberships.length > 0) {
      throw new OrganizationConversionError(
        "The account must leave organizations before conversion.",
      );
    }

    const pendingMemberships = await tx.query.organizationMembershipTable
      .findMany({
        where: {
          memberAccountId: request.accountId,
          accepted: { isNull: true },
        },
        columns: { organizationAccountId: true },
      });
    for (const membership of pendingMemberships) {
      await deleteOrganizationInvitationNotification(
        tx,
        membership.organizationAccountId,
        request.accountId,
      );
    }
    await tx.delete(organizationMembershipTable)
      .where(and(
        eq(organizationMembershipTable.memberAccountId, request.accountId),
        isNull(organizationMembershipTable.accepted),
      ));

    await tx.delete(accountEmailTable)
      .where(eq(accountEmailTable.accountId, request.accountId));
    await tx.delete(passkeyTable)
      .where(eq(passkeyTable.accountId, request.accountId));
    await tx.delete(pushNotificationTargetTable)
      .where(eq(pushNotificationTargetTable.accountId, request.accountId));
    await tx.delete(invitationLinkTable)
      .where(eq(invitationLinkTable.inviterId, request.accountId));
    await tx.update(accountTable)
      .set({
        kind: "organization",
        leftInvitations: 0,
        updated: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(accountTable.id, request.accountId));
    await tx.insert(organizationMembershipTable).values({
      organizationAccountId: request.accountId,
      memberAccountId: adminAccount.id,
      role: "admin",
      invitedById: adminAccount.id,
      accepted: sql`CURRENT_TIMESTAMP`,
    }).onConflictDoUpdate({
      target: [
        organizationMembershipTable.organizationAccountId,
        organizationMembershipTable.memberAccountId,
      ],
      set: {
        role: "admin",
        accepted: sql`CURRENT_TIMESTAMP`,
        updated: sql`CURRENT_TIMESTAMP`,
      },
    });
    await tx.update(organizationConversionRequestTable)
      .set({
        accepted: sql`CURRENT_TIMESTAMP`,
        updated: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(organizationConversionRequestTable.id, request.id));

    const txFedCtx = asTransactionalFedCtx(fedCtx, tx);
    const organization = await loadAccountForSync(tx, request.accountId);
    const actor = await syncActorFromAccount(txFedCtx, organization);
    return { ...organization, actor };
  });
  await sendAccountActorUpdate(fedCtx, organization.id, organization.updated);
  return organization;
}

export async function resolveActingAccount(
  db: Database | Transaction,
  viewer: AccountWithActor,
  actingAccountId?: Uuid | null,
): Promise<AccountWithActor> {
  if (actingAccountId == null || actingAccountId === viewer.id) {
    if (viewer.kind !== "personal") {
      throw new OrganizationPermissionError();
    }
    return viewer;
  }
  const membership = await getAcceptedMembership(
    db,
    actingAccountId,
    viewer.id,
  );
  if (membership == null) throw new OrganizationPermissionError();
  const organization = await loadAccountWithActor(db, actingAccountId);
  if (organization.kind !== "organization") {
    throw new OrganizationPermissionError();
  }
  return organization;
}

export async function recordOrganizationPostAuthor(
  db: Database | Transaction,
  postId: Uuid,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
  attributionMode: "acting_account_only" | "acting_account_with_viewer",
): Promise<void> {
  const membership = await getAcceptedMembership(
    db,
    organizationAccountId,
    memberAccountId,
  );
  if (membership == null) throw new OrganizationPermissionError();
  await db.insert(organizationPostAuthorTable)
    .values({
      postId,
      organizationAccountId,
      memberAccountId,
      attributionMode,
    })
    .onConflictDoUpdate({
      target: organizationPostAuthorTable.postId,
      set: {
        organizationAccountId,
        memberAccountId,
        attributionMode,
      },
    });
}

export async function getOrganizationNotificationBadge(
  db: Database | Transaction,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
  markReadAt?: Date,
): Promise<OrganizationNotificationBadge> {
  const membership = await getAcceptedMembership(
    db,
    organizationAccountId,
    memberAccountId,
  );
  if (membership == null) throw new OrganizationPermissionError();

  if (markReadAt != null) {
    await db.insert(organizationNotificationReadTable).values({
      organizationAccountId,
      memberAccountId,
      readAt: markReadAt,
    }).onConflictDoUpdate({
      target: [
        organizationNotificationReadTable.organizationAccountId,
        organizationNotificationReadTable.memberAccountId,
      ],
      set: {
        readAt: sql`GREATEST(
          ${organizationNotificationReadTable.readAt},
          ${markReadAt.toISOString()}::timestamptz
        )`,
        updated: sql`CURRENT_TIMESTAMP`,
      },
    });
  }

  const globalReadAt = sql`
    COALESCE(
      (
        SELECT MAX(${organizationNotificationReadTable.readAt})
        FROM ${organizationNotificationReadTable}
        WHERE ${organizationNotificationReadTable.organizationAccountId} =
          ${organizationAccountId}
          AND EXISTS (
            SELECT 1
            FROM ${organizationMembershipTable}
            WHERE ${organizationMembershipTable.organizationAccountId} =
              ${organizationNotificationReadTable.organizationAccountId}
              AND ${organizationMembershipTable.memberAccountId} =
              ${organizationNotificationReadTable.memberAccountId}
              AND ${organizationMembershipTable.accepted} IS NOT NULL
          )
      ),
      '-infinity'::timestamptz
    )
  `;
  const memberReadAt = sql`
    COALESCE(
      (
        SELECT ${organizationNotificationReadTable.readAt}
        FROM ${organizationNotificationReadTable}
        WHERE ${organizationNotificationReadTable.organizationAccountId} =
          ${organizationAccountId}
          AND ${organizationNotificationReadTable.memberAccountId} =
          ${memberAccountId}
      ),
      '-infinity'::timestamptz
    )
  `;
  const notificationHasExistingActors = sql`EXISTS (
    SELECT 1
    FROM ${actorTable}
    WHERE ${actorTable.id} = ANY(${notificationTable.actorIds})
  )`;
  const redRows = await db.select({ count: count() })
    .from(notificationTable)
    .where(and(
      eq(notificationTable.accountId, organizationAccountId),
      sql`${notificationTable.created} > ${globalReadAt}`,
      notificationHasExistingActors,
    ));
  const redCount = Number(redRows[0]?.count ?? 0);
  if (redCount > 0) return { color: "red", count: redCount };

  const grayRows = await db.select({ count: count() })
    .from(notificationTable)
    .where(and(
      eq(notificationTable.accountId, organizationAccountId),
      sql`${notificationTable.created} > ${memberReadAt}`,
      notificationHasExistingActors,
    ));
  const grayCount = Number(grayRows[0]?.count ?? 0);
  if (grayCount > 0) return { color: "gray", count: grayCount };
  return { color: null, count: 0 };
}

export async function markOrganizationNotificationsReadThrough(
  db: Database | Transaction,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
  notificationId: Uuid,
): Promise<boolean> {
  const membership = await getAcceptedMembership(
    db,
    organizationAccountId,
    memberAccountId,
  );
  if (membership == null) throw new OrganizationPermissionError();

  const notificationRows = await db.select({ id: notificationTable.id })
    .from(notificationTable)
    .where(and(
      eq(notificationTable.id, notificationId),
      eq(notificationTable.accountId, organizationAccountId),
    ))
    .limit(1);
  if (notificationRows.length < 1) return false;

  await db.insert(organizationNotificationReadTable).values({
    organizationAccountId,
    memberAccountId,
    readAt: sql`(
      SELECT LEAST(${notificationTable.created}, CURRENT_TIMESTAMP)
      FROM ${notificationTable}
      WHERE ${notificationTable.id} = ${notificationId}
        AND ${notificationTable.accountId} = ${organizationAccountId}
    )`,
  }).onConflictDoUpdate({
    target: [
      organizationNotificationReadTable.organizationAccountId,
      organizationNotificationReadTable.memberAccountId,
    ],
    set: {
      readAt: sql`GREATEST(
        ${organizationNotificationReadTable.readAt},
        EXCLUDED.read_at
      )`,
      updated: sql`CURRENT_TIMESTAMP`,
    },
  });
  return true;
}
