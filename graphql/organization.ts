import {
  acceptOrganizationConversion as acceptOrganizationConversionModel,
  acceptOrganizationInvitation as acceptOrganizationInvitationModel,
  createOrganization as createOrganizationModel,
  getOrganizationNotificationBadge,
  inviteOrganizationMember as inviteOrganizationMemberModel,
  LastOrganizationAdminError,
  LastOrganizationMemberError,
  leaveOrganization as leaveOrganizationModel,
  markOrganizationNotificationsReadThrough,
  OrganizationConversionError,
  OrganizationInvitationRequiredError,
  OrganizationMembershipError,
  OrganizationPermissionError,
  removeOrganizationMember as removeOrganizationMemberModel,
  requestOrganizationConversion as requestOrganizationConversionModel,
  updateOrganizationMemberRole as updateOrganizationMemberRoleModel,
} from "@hackerspub/models/organization";
import type {
  Account as AccountRow,
  OrganizationConversionRequest,
  OrganizationMemberRole as OrganizationMemberRoleValue,
  OrganizationMembership,
} from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { Account } from "./account.ts";
import { builder, type UserContext } from "./builder.ts";
import { InvalidInputError, NotAuthorizedError } from "./error.ts";
import { OrganizationConversionRequestRef } from "./organization-conversion-request.ts";
import { OrganizationMembershipRef } from "./organization-membership.ts";
import { NotAuthenticatedError } from "./session.ts";

type AccountForGraphql = AccountRow & {
  actor?: unknown;
};

interface OrganizationPayload {
  organization: AccountForGraphql;
  membership: OrganizationMembership;
}

interface OrganizationConversionRequestPayload {
  request: OrganizationConversionRequest;
}

interface OrganizationNotificationBadgeShape {
  color: "red" | "gray" | null;
  count: number;
}

builder.objectType(OrganizationInvitationRequiredError, {
  name: "OrganizationInvitationRequiredError",
  description:
    "Returned when a personal account tries to create an organization " +
    "without an available invitation slot.",
  fields: (t) => ({
    message: t.exposeString("message", {
      description:
        "Human-readable diagnostic. Use `__typename` for stable branching.",
    }),
  }),
});

builder.objectType(OrganizationPermissionError, {
  name: "OrganizationPermissionError",
  description:
    "Returned when the authenticated account is not an accepted member or " +
    "administrator of the organization required by the operation.",
  fields: (t) => ({
    message: t.exposeString("message", {
      description:
        "Human-readable diagnostic. Use `__typename` for stable branching.",
    }),
  }),
});

builder.objectType(OrganizationMembershipError, {
  name: "OrganizationMembershipError",
  description:
    "Returned when an organization membership operation cannot be applied, " +
    "for example because the invitation or member row does not exist.",
  fields: (t) => ({
    message: t.exposeString("message", {
      description:
        "Human-readable diagnostic. Use `__typename` for stable branching.",
    }),
  }),
});

builder.objectType(LastOrganizationMemberError, {
  name: "LastOrganizationMemberError",
  description:
    "Returned when a leave or remove operation would leave the organization " +
    "with no members. Delete the organization instead.",
  fields: (t) => ({
    message: t.exposeString("message", {
      description:
        "Human-readable diagnostic. Use `__typename` for stable branching.",
    }),
  }),
});

builder.objectType(LastOrganizationAdminError, {
  name: "LastOrganizationAdminError",
  description:
    "Returned when a leave, remove, or role-change operation would leave " +
    "the organization with no administrators.",
  fields: (t) => ({
    message: t.exposeString("message", {
      description:
        "Human-readable diagnostic. Use `__typename` for stable branching.",
    }),
  }),
});

builder.objectType(OrganizationConversionError, {
  name: "OrganizationConversionError",
  description: "Returned when a personal account cannot be converted into an " +
    "organization, or when an administrator cannot accept that conversion.",
  fields: (t) => ({
    message: t.exposeString("message", {
      description:
        "Human-readable diagnostic. Use `__typename` for stable branching.",
    }),
  }),
});

export const AccountKind = builder.enumType("AccountKind", {
  description:
    "Distinguishes login-capable personal accounts from organization " +
    "accounts that share the username and WebFinger namespace.",
  values: {
    PERSONAL: {
      value: "personal",
      description:
        "A regular account controlled directly by one person. Only personal " +
        "accounts can sign in.",
    },
    ORGANIZATION: {
      value: "organization",
      description:
        "An organization or team account controlled through one or more " +
        "personal member accounts.",
    },
  } as const,
});

export const OrganizationMemberRole = builder.enumType(
  "OrganizationMemberRole",
  {
    description:
      "Role held by a personal account inside an organization account.",
    values: {
      ADMIN: {
        value: "admin",
        description:
          "Can update organization settings and manage organization members.",
      },
      MEMBER: {
        value: "member",
        description:
          "Can act as the organization for posting and social actions, but " +
          "cannot manage settings or membership.",
      },
    } as const,
  },
);

const OrganizationNotificationBadgeColor = builder.enumType(
  "OrganizationNotificationBadgeColor",
  {
    description:
      "Badge severity for organization notifications. `RED` means no " +
      "member has read the newest notifications; `GRAY` means some other " +
      "member has read them but this viewer has not.",
    values: {
      RED: {
        value: "red",
        description:
          "There are notifications newer than the newest read marker from " +
          "any organization member.",
      },
      GRAY: {
        value: "gray",
        description:
          "All notifications have been read by at least one member, but " +
          "some are still unread by the current viewer.",
      },
    } as const,
  },
);

const OrganizationNotificationBadge = builder.objectRef<
  OrganizationNotificationBadgeShape
>("OrganizationNotificationBadge");

OrganizationNotificationBadge.implement({
  description:
    "Unread notification badge state for one organization as seen by one " +
    "member. A `null` color with count `0` means no badge should be shown.",
  fields: (t) => ({
    color: t.field({
      type: OrganizationNotificationBadgeColor,
      nullable: true,
      description:
        "The badge color to render. `null` means no unread organization " +
        "notifications for this member.",
      resolve: (badge) => badge.color,
    }),
    count: t.exposeInt("count", {
      description: "The number to show in the organization notification badge.",
    }),
  }),
});

OrganizationMembershipRef.implement({
  description:
    "Membership of a personal `Account` in an organization `Account`. " +
    "Rows with `accepted: null` are pending invitations; accepted rows grant " +
    "access to the organization account.",
  fields: (t) => ({
    role: t.field({
      type: OrganizationMemberRole,
      description: "Role currently held by the member in this organization.",
      resolve: (membership) => membership.role,
    }),
    accepted: t.expose("accepted", {
      type: "DateTime",
      nullable: true,
      description:
        "When the invitation was accepted, or `null` for a pending invite.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When this membership or invitation was created.",
    }),
    organization: t.field({
      type: Account,
      description: "The organization account this membership grants access to.",
      async resolve(membership, _, ctx) {
        return await loadAccount(ctx, membership.organizationAccountId);
      },
    }),
    member: t.field({
      type: Account,
      description: "The personal account that belongs to the organization.",
      async resolve(membership, _, ctx) {
        return await loadAccount(ctx, membership.memberAccountId);
      },
    }),
    notificationBadge: t.field({
      type: OrganizationNotificationBadge,
      nullable: true,
      description:
        "Unread notification badge for this organization as seen by this " +
        "member. Returns `null` for pending invitations and when resolving " +
        "a membership that does not belong to the authenticated viewer.",
      async resolve(membership, _, ctx) {
        if (membership.accepted == null) return null;
        if (
          ctx.account == null || membership.memberAccountId !== ctx.account.id
        ) {
          return null;
        }
        const badge = await getOrganizationNotificationBadge(
          ctx.db,
          membership.organizationAccountId,
          membership.memberAccountId,
        );
        return badge;
      },
    }),
  }),
});

OrganizationConversionRequestRef.implement({
  description:
    "Pending or accepted request to convert one personal `Account` into an " +
    "organization `Account`. The accepting admin becomes the first " +
    "organization administrator.",
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "Stable UUID for accepting this conversion request.",
    }),
    account: t.field({
      type: Account,
      description:
        "The account that will become an organization after acceptance.",
      async resolve(request, _, ctx) {
        return await loadAccount(ctx, request.accountId);
      },
    }),
    admin: t.field({
      type: Account,
      description:
        "The personal account allowed to accept the conversion request.",
      async resolve(request, _, ctx) {
        return await loadAccount(ctx, request.adminAccountId);
      },
    }),
    accepted: t.expose("accepted", {
      type: "DateTime",
      nullable: true,
      description:
        "When the request was accepted, or `null` while it is still pending.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When the conversion request was created.",
    }),
  }),
});

async function loadAccount(
  ctx: UserContext,
  id: Uuid,
): Promise<AccountRow & { actor: NonNullable<unknown> }> {
  const account = await ctx.db.query.accountTable.findFirst({
    where: { id },
    with: { actor: true },
  });
  if (account == null || account.actor == null) {
    throw new InvalidInputError("accountId");
  }
  return account as AccountRow & { actor: NonNullable<unknown> };
}

builder.queryField("organizationConversionRequest", (t) =>
  t.field({
    type: OrganizationConversionRequestRef,
    nullable: true,
    description:
      "Look up an organization conversion request for the authenticated " +
      "account. Only the account being converted, the designated accepting " +
      "admin, and moderators can read it; other viewers receive `null`.",
    args: {
      id: t.arg({
        type: "UUID",
        required: true,
        description:
          "UUID of the `OrganizationConversionRequest` to display or accept.",
      }),
    },
    async resolve(_root, args, ctx) {
      const viewer = ctx.account;
      if (viewer == null) return null;
      if (!validateUuid(args.id)) return null;
      const request = await ctx.db.query.organizationConversionRequestTable
        .findFirst({
          where: { id: args.id as Uuid },
        });
      if (request == null) return null;
      if (
        !viewer.moderator &&
        request.accountId !== viewer.id &&
        request.adminAccountId !== viewer.id
      ) {
        return null;
      }
      return request;
    },
  }));

async function requirePersonalAccount(ctx: UserContext) {
  const session = await ctx.session;
  if (session == null || ctx.account == null) {
    throw new NotAuthenticatedError();
  }
  if (ctx.account.kind !== "personal") throw new NotAuthorizedError();
  return ctx.account;
}

async function requireMembership(
  ctx: UserContext,
  organizationAccountId: Uuid,
  memberAccountId: Uuid,
): Promise<OrganizationMembership> {
  const membership = await ctx.db.query.organizationMembershipTable.findFirst({
    where: {
      organizationAccountId,
      memberAccountId,
      accepted: { isNotNull: true },
    },
  });
  if (membership == null) throw new OrganizationPermissionError();
  return membership;
}

function parseAccountId(id: string, inputPath: string): Uuid {
  if (!validateUuid(id)) throw new InvalidInputError(inputPath);
  return id;
}

builder.drizzleObjectField(Account, "kind", (t) =>
  t.field({
    type: AccountKind,
    description:
      "`PERSONAL` for direct login accounts and `ORGANIZATION` for team " +
      "accounts controlled through organization memberships.",
    select: { columns: { kind: true } },
    resolve(account) {
      return account.kind;
    },
  }));

builder.drizzleObjectField(Account, "organizationMemberships", (t) =>
  t.field({
    type: [OrganizationMembershipRef],
    description:
      "Accepted organization memberships for this personal account, newest " +
      "first. Only visible to the account holder and moderators.",
    authScopes: (parent) => ({
      moderator: true,
      selfAccount: parent.id,
    }),
    select: {
      columns: { id: true },
    },
    async resolve(account, _, ctx) {
      return await ctx.db.query.organizationMembershipTable.findMany({
        where: {
          memberAccountId: account.id,
          accepted: { isNotNull: true },
        },
        orderBy: { created: "desc" },
      });
    },
  }));

builder.drizzleObjectField(Account, "organizationInvitations", (t) =>
  t.field({
    type: [OrganizationMembershipRef],
    description:
      "Pending organization invitations for this personal account, newest " +
      "first. Only visible to the account holder and moderators; accepted " +
      "memberships move to `organizationMemberships`.",
    authScopes: (parent) => ({
      moderator: true,
      selfAccount: parent.id,
    }),
    select: {
      columns: { id: true },
    },
    async resolve(account, _, ctx) {
      return await ctx.db.query.organizationMembershipTable.findMany({
        where: {
          memberAccountId: account.id,
          accepted: { isNull: true },
        },
        orderBy: { created: "desc" },
      });
    },
  }));

builder.drizzleObjectField(Account, "organizationMembers", (t) =>
  t.field({
    type: [OrganizationMembershipRef],
    description:
      "Pending and accepted members of this organization account, newest " +
      "first. Readable by accepted organization members and moderators.",
    select: {
      columns: { id: true, kind: true },
    },
    async resolve(account, _, ctx) {
      if (account.kind !== "organization") return [];
      const viewer = ctx.account;
      if (viewer == null) {
        throw new NotAuthenticatedError();
      }
      if (!viewer.moderator) {
        try {
          await requireMembership(ctx, account.id, viewer.id);
        } catch (error) {
          if (error instanceof OrganizationPermissionError) {
            throw new NotAuthorizedError();
          }
          throw error;
        }
      }
      return await ctx.db.query.organizationMembershipTable.findMany({
        where: {
          organizationAccountId: account.id,
        },
        orderBy: { created: "desc" },
      });
    },
  }));

builder.relayMutationField(
  "createOrganization",
  {
    description:
      "Create a new organization account in the shared username namespace. " +
      "The authenticated personal account spends one invitation and becomes " +
      "the first organization administrator.",
    inputFields: (t) => ({
      username: t.string({
        required: true,
        description:
          "Username for the organization account. It must not collide with " +
          "any personal or organization account.",
      }),
      name: t.string({
        required: true,
        description: "Display name for the organization profile.",
      }),
      bio: t.string({
        required: true,
        description:
          "Markdown profile bio for the organization account. Pass an " +
          "empty string for no bio.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        OrganizationInvitationRequiredError,
        OrganizationMembershipError,
      ],
    },
    async resolve(_root, args, ctx): Promise<OrganizationPayload> {
      const creator = await requirePersonalAccount(ctx);
      const organization = await createOrganizationModel(ctx.fedCtx, creator, {
        username: args.input.username,
        name: args.input.name,
        bio: args.input.bio,
      });
      const membership = await requireMembership(
        ctx,
        organization.id,
        creator.id,
      );
      return { organization, membership };
    },
  },
  {
    outputFields: (t) => ({
      organization: t.field({
        type: Account,
        description: "The organization account that was created.",
        resolve: (payload) => payload.organization,
      }),
      membership: t.field({
        type: OrganizationMembershipRef,
        description: "The creator's accepted administrator membership in the " +
          "organization.",
        resolve: (payload) => payload.membership,
      }),
    }),
  },
);

builder.relayMutationField(
  "inviteOrganizationMember",
  {
    description:
      "Invite a personal account to join an organization. Only accepted " +
      "organization administrators can invite or re-read a pending invite.",
    inputFields: (t) => ({
      organizationId: t.globalID({
        for: Account,
        required: true,
        description:
          "Global `Account` id of the organization that will receive the " +
          "member.",
      }),
      username: t.string({
        required: true,
        description: "Username of the personal account to invite.",
      }),
      role: t.field({
        type: OrganizationMemberRole,
        required: false,
        description: "Role to grant after acceptance. Defaults to `MEMBER`.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        OrganizationPermissionError,
        OrganizationMembershipError,
      ],
    },
    async resolve(_root, args, ctx): Promise<OrganizationMembership> {
      const admin = await requirePersonalAccount(ctx);
      return await inviteOrganizationMemberModel(
        ctx.db,
        admin,
        parseAccountId(args.input.organizationId.id, "organizationId"),
        args.input.username,
        (args.input.role ?? "member") as OrganizationMemberRoleValue,
      );
    },
  },
  {
    outputFields: (t) => ({
      membership: t.field({
        type: OrganizationMembershipRef,
        description:
          "The pending or existing organization membership invitation.",
        resolve: (membership) => membership,
      }),
    }),
  },
);

builder.relayMutationField(
  "acceptOrganizationInvitation",
  {
    description:
      "Accept a pending organization invitation for the authenticated " +
      "personal account.",
    inputFields: (t) => ({
      organizationId: t.globalID({
        for: Account,
        required: true,
        description:
          "Global `Account` id of the organization whose invitation should " +
          "be accepted.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        OrganizationMembershipError,
      ],
    },
    async resolve(_root, args, ctx): Promise<OrganizationMembership> {
      const member = await requirePersonalAccount(ctx);
      return await acceptOrganizationInvitationModel(
        ctx.db,
        member,
        parseAccountId(args.input.organizationId.id, "organizationId"),
      );
    },
  },
  {
    outputFields: (t) => ({
      membership: t.field({
        type: OrganizationMembershipRef,
        description: "The accepted organization membership.",
        resolve: (membership) => membership,
      }),
    }),
  },
);

builder.relayMutationField(
  "leaveOrganization",
  {
    description:
      "Leave an organization as the authenticated member. The last member " +
      "or last administrator cannot leave; delete the organization or add " +
      "another administrator first.",
    inputFields: (t) => ({
      organizationId: t.globalID({
        for: Account,
        required: true,
        description: "Global `Account` id of the organization to leave.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        OrganizationMembershipError,
        LastOrganizationMemberError,
        LastOrganizationAdminError,
      ],
    },
    async resolve(_root, args, ctx): Promise<OrganizationMembership> {
      const member = await requirePersonalAccount(ctx);
      return await leaveOrganizationModel(
        ctx.db,
        member,
        parseAccountId(args.input.organizationId.id, "organizationId"),
      );
    },
  },
  {
    outputFields: (t) => ({
      membership: t.field({
        type: OrganizationMembershipRef,
        description: "The membership row that was removed.",
        resolve: (membership) => membership,
      }),
    }),
  },
);

builder.relayMutationField(
  "updateOrganizationMemberRole",
  {
    description:
      "Change the role of an accepted organization member. Only accepted " +
      "organization administrators can update roles, and the last " +
      "administrator cannot be demoted.",
    inputFields: (t) => ({
      organizationId: t.globalID({
        for: Account,
        required: true,
        description:
          "Global `Account` id of the organization whose member should be " +
          "updated.",
      }),
      memberId: t.globalID({
        for: Account,
        required: true,
        description:
          "Global `Account` id of the accepted personal member to update.",
      }),
      role: t.field({
        type: OrganizationMemberRole,
        required: true,
        description: "New role to store for the accepted organization member.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        OrganizationPermissionError,
        OrganizationMembershipError,
        LastOrganizationAdminError,
      ],
    },
    async resolve(_root, args, ctx): Promise<OrganizationMembership> {
      const admin = await requirePersonalAccount(ctx);
      return await updateOrganizationMemberRoleModel(
        ctx.db,
        admin,
        parseAccountId(args.input.organizationId.id, "organizationId"),
        parseAccountId(args.input.memberId.id, "memberId"),
        args.input.role as OrganizationMemberRoleValue,
      );
    },
  },
  {
    outputFields: (t) => ({
      membership: t.field({
        type: OrganizationMembershipRef,
        description: "The updated organization membership.",
        resolve: (membership) => membership,
      }),
    }),
  },
);

builder.relayMutationField(
  "removeOrganizationMember",
  {
    description:
      "Remove an accepted member or cancel a pending invitation from an " +
      "organization. Only accepted organization administrators can remove " +
      "members, and the last accepted member or administrator cannot be " +
      "removed.",
    inputFields: (t) => ({
      organizationId: t.globalID({
        for: Account,
        required: true,
        description:
          "Global `Account` id of the organization whose member should be " +
          "removed.",
      }),
      memberId: t.globalID({
        for: Account,
        required: true,
        description:
          "Global `Account` id of the personal member or invitee to remove.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        OrganizationPermissionError,
        OrganizationMembershipError,
        LastOrganizationMemberError,
        LastOrganizationAdminError,
      ],
    },
    async resolve(_root, args, ctx): Promise<OrganizationMembership> {
      const admin = await requirePersonalAccount(ctx);
      return await removeOrganizationMemberModel(
        ctx.db,
        admin,
        parseAccountId(args.input.organizationId.id, "organizationId"),
        parseAccountId(args.input.memberId.id, "memberId"),
      );
    },
  },
  {
    outputFields: (t) => ({
      membership: t.field({
        type: OrganizationMembershipRef,
        description: "The organization membership that was removed.",
        resolve: (membership) => membership,
      }),
    }),
  },
);

builder.relayMutationField(
  "requestOrganizationConversion",
  {
    description:
      "Request irreversible conversion of the authenticated personal " +
      "account into an organization account. The current username must be " +
      "typed as confirmation, and a different personal account must be " +
      "named as the accepting administrator. The account must not belong to " +
      "any organization: leave every organization first, otherwise this " +
      "fails with `OrganizationConversionError`.",
    inputFields: (t) => ({
      accountId: t.globalID({
        for: Account,
        required: true,
        description:
          "Global `Account` id of the authenticated personal account to " +
          "convert.",
      }),
      adminUsername: t.string({
        required: true,
        description:
          "Username of the personal account that may accept the conversion " +
          "and become the first organization administrator.",
      }),
      confirmationUsername: t.string({
        required: true,
        description:
          "Exact current username of the account being converted. This " +
          "mirrors account deletion confirmation because conversion cannot " +
          "be undone.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        InvalidInputError,
        OrganizationConversionError,
      ],
    },
    async resolve(
      _root,
      args,
      ctx,
    ): Promise<OrganizationConversionRequestPayload> {
      const account = await requirePersonalAccount(ctx);
      const accountId = parseAccountId(args.input.accountId.id, "accountId");
      if (account.id !== accountId) throw new NotAuthorizedError();
      const request = await requestOrganizationConversionModel(
        ctx.db,
        account,
        args.input.adminUsername,
        args.input.confirmationUsername,
      );
      return { request };
    },
  },
  {
    outputFields: (t) => ({
      request: t.field({
        type: OrganizationConversionRequestRef,
        description:
          "The pending conversion request. Give `request.uuid` to the named " +
          "admin so they can accept it.",
        resolve: (payload) => payload.request,
      }),
    }),
  },
);

builder.relayMutationField(
  "acceptOrganizationConversion",
  {
    description:
      "Accept a pending organization conversion request. The authenticated " +
      "personal account must match the admin chosen by the converting " +
      "account.",
    inputFields: (t) => ({
      requestId: t.field({
        type: "UUID",
        required: true,
        description:
          "UUID of the pending `OrganizationConversionRequest` to accept.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        InvalidInputError,
        OrganizationConversionError,
      ],
    },
    async resolve(_root, args, ctx): Promise<OrganizationPayload> {
      const admin = await requirePersonalAccount(ctx);
      if (!validateUuid(args.input.requestId)) {
        throw new InvalidInputError("requestId");
      }
      const organization = await acceptOrganizationConversionModel(
        ctx.fedCtx,
        admin,
        args.input.requestId as Uuid,
      );
      const membership = await requireMembership(
        ctx,
        organization.id,
        admin.id,
      );
      return { organization, membership };
    },
  },
  {
    outputFields: (t) => ({
      organization: t.field({
        type: Account,
        description: "The converted organization account.",
        resolve: (payload) => payload.organization,
      }),
      membership: t.field({
        type: OrganizationMembershipRef,
        description: "The accepting admin's organization membership.",
        resolve: (payload) => payload.membership,
      }),
    }),
  },
);

builder.relayMutationField(
  "markOrganizationNotificationsAsRead",
  {
    description:
      "Advance this member's read marker for one organization and return " +
      "the resulting badge state.",
    inputFields: (t) => ({
      organizationId: t.globalID({
        for: Account,
        required: true,
        description:
          "Global `Account` id of the organization whose notifications " +
          "should be marked read.",
      }),
      read: t.field({
        type: "DateTime",
        required: false,
        description:
          "Read marker to store. Omit to use the current server time. " +
          "Future timestamps are clamped to the current server time. " +
          "Prefer `upTo` when marking notifications loaded from the API, " +
          "because it preserves database timestamp precision.",
      }),
      // TODO: Remove this compatibility alias after external clients migrate
      // to `read`.
      readAt: t.field({
        type: "DateTime",
        required: false,
        deprecationReason: "Use `read` instead.",
        description:
          "Deprecated compatibility alias for `read`. Use `read` to provide " +
          "the notification read marker.",
      }),
      upTo: t.field({
        type: "UUID",
        required: false,
        description:
          "UUID of the newest loaded organization notification to mark " +
          "as read through. This stores the notification row's server-side " +
          "`created` timestamp, preserving database precision.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(
      _root,
      args,
      ctx,
    ): Promise<OrganizationNotificationBadgeShape> {
      const member = await requirePersonalAccount(ctx);
      const organizationId = parseAccountId(
        args.input.organizationId.id,
        "organizationId",
      );
      if (args.input.upTo != null) {
        if (!validateUuid(args.input.upTo)) {
          throw new InvalidInputError("upTo");
        }
        const marked = await markOrganizationNotificationsReadThrough(
          ctx.db,
          organizationId,
          member.id,
          args.input.upTo as Uuid,
        );
        if (!marked) throw new InvalidInputError("upTo");
        return await getOrganizationNotificationBadge(
          ctx.db,
          organizationId,
          member.id,
        );
      }
      const now = new Date();
      const requestedRead = args.input.read ?? args.input["readAt"];
      const read = requestedRead == null || requestedRead > now
        ? now
        : requestedRead;
      return await getOrganizationNotificationBadge(
        ctx.db,
        organizationId,
        member.id,
        read,
      );
    },
  },
  {
    outputFields: (t) => ({
      badge: t.field({
        type: OrganizationNotificationBadge,
        description: "Badge state after storing the member read marker.",
        resolve: (badge) => badge,
      }),
    }),
  },
);
