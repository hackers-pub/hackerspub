import type { Context } from "@fedify/fedify";
import { and, count, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { syncActorFromAccount } from "./actor.ts";
import type { ContextData } from "./context.ts";
import type { Database, Transaction } from "./db.ts";
import {
  type Account,
  type AccountEmail,
  accountEmailTable,
  type AccountLink,
  accountTable,
  type Actor,
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
} from "./schema.ts";
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
    super("The last admin cannot leave or be demoted.");
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
  return {
    ...fedCtx,
    data: {
      ...fedCtx.data,
      db: tx,
    },
  };
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
  const db = fedCtx.data.db;
  return await runInTransaction(db, async (tx) => {
    const username = normalizeUsername(input.username);
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
      name: input.name,
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
  if (rows[0] != null) return rows[0];
  const existing = await db.query.organizationMembershipTable.findFirst({
    where: { organizationAccountId, memberAccountId: member.id },
  });
  if (existing == null) {
    throw new OrganizationMembershipError("Failed to invite member.");
  }
  return existing;
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
  await assertOrganizationAdmin(db, adminAccount, organizationAccountId);
  const membership = await getAcceptedMembership(
    db,
    organizationAccountId,
    memberAccountId,
  );
  if (membership == null) {
    throw new OrganizationMembershipError("The member does not exist.");
  }
  if (membership.role === "admin" && role === "member") {
    const admins = await countAcceptedAdmins(db, organizationAccountId);
    if (admins <= 1) throw new LastOrganizationAdminError();
  }
  const rows = await db.update(organizationMembershipTable)
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
}

export async function removeOrganizationMember(
  db: Database | Transaction,
  adminAccount: Pick<Account, "id" | "kind">,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
): Promise<OrganizationMembership> {
  await assertOrganizationAdmin(db, adminAccount, organizationAccountId);
  return await removeAcceptedMembership(
    db,
    organizationAccountId,
    memberAccountId,
  );
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
  const membership = await getAcceptedMembership(
    db,
    organizationAccountId,
    memberAccountId,
  );
  if (membership == null) {
    throw new OrganizationMembershipError("The member does not exist.");
  }
  const members = await countAcceptedMembers(db, organizationAccountId);
  if (members <= 1) throw new LastOrganizationMemberError();
  if (membership.role === "admin") {
    const admins = await countAcceptedAdmins(db, organizationAccountId);
    if (admins <= 1) throw new LastOrganizationAdminError();
  }
  const rows = await db.delete(organizationMembershipTable)
    .where(and(
      eq(
        organizationMembershipTable.organizationAccountId,
        organizationAccountId,
      ),
      eq(organizationMembershipTable.memberAccountId, memberAccountId),
      isNotNull(organizationMembershipTable.accepted),
    ))
    .returning();
  return rows[0]!;
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
  if (pending != null) return pending;
  const rows = await db.insert(organizationConversionRequestTable).values({
    id: generateUuidV7(),
    accountId: account.id,
    adminAccountId: admin.id,
  }).returning();
  return rows[0];
}

export async function acceptOrganizationConversion(
  fedCtx: Context<ContextData>,
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
  return await runInTransaction(db, async (tx) => {
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
    const existingMembership = await tx.query.organizationMembershipTable
      .findFirst({
        where: { memberAccountId: request.accountId },
        columns: {
          organizationAccountId: true,
        },
      });
    if (existingMembership != null) {
      throw new OrganizationConversionError(
        "The account must leave organizations before conversion.",
      );
    }

    await tx.delete(accountEmailTable)
      .where(eq(accountEmailTable.accountId, request.accountId));
    await tx.delete(passkeyTable)
      .where(eq(passkeyTable.accountId, request.accountId));
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
  const redRows = await db.select({ count: count() })
    .from(notificationTable)
    .where(and(
      eq(notificationTable.accountId, organizationAccountId),
      sql`${notificationTable.created} > ${globalReadAt}`,
    ));
  const redCount = Number(redRows[0]?.count ?? 0);
  if (redCount > 0) return { color: "red", count: redCount };

  const grayRows = await db.select({ count: count() })
    .from(notificationTable)
    .where(and(
      eq(notificationTable.accountId, organizationAccountId),
      sql`${notificationTable.created} > ${memberReadAt}`,
    ));
  const grayCount = Number(grayRows[0]?.count ?? 0);
  if (grayCount > 0) return { color: "gray", count: grayCount };
  return { color: null, count: 0 };
}
