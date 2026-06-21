import assert from "node:assert";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import {
  createOrganization,
  getOrganizationNotificationBadge,
} from "@hackerspub/models/organization";
import {
  accountTable,
  notificationTable,
  organizationMembershipTable,
} from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const createOrganizationMutation = parse(`
  mutation CreateOrganization($input: CreateOrganizationInput!) {
    createOrganization(input: $input) {
      __typename
      ... on CreateOrganizationPayload {
        organization {
          username
          kind
          actor { type }
          inviter { username }
        }
        membership {
          role
          accepted
          organization { username }
          member { username }
        }
      }
      ... on OrganizationInvitationRequiredError { message }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`);

const viewerOrganizationStateQuery = parse(`
  query ViewerOrganizationState {
    viewer {
      kind
      organizationMemberships {
        role
        organization {
          username
          kind
        }
        notificationBadge {
          color
          count
        }
      }
    }
  }
`);

const conversionMutation = parse(`
  mutation ConvertAccount(
    $accountId: ID!
    $adminUsername: String!
    $confirmationUsername: String!
  ) {
    requestOrganizationConversion(input: {
      accountId: $accountId
      adminUsername: $adminUsername
      confirmationUsername: $confirmationUsername
    }) {
      __typename
      ... on RequestOrganizationConversionPayload {
        request {
          uuid
          account { username kind }
          admin { username }
          accepted
        }
      }
      ... on OrganizationConversionError { message }
    }
  }
`);

const acceptConversionMutation = parse(`
  mutation AcceptConversion($requestId: UUID!) {
    acceptOrganizationConversion(input: { requestId: $requestId }) {
      __typename
      ... on AcceptOrganizationConversionPayload {
        organization {
          username
          kind
          actor { type }
        }
        membership {
          role
          organization { username }
          member { username }
        }
      }
      ... on OrganizationConversionError { message }
    }
  }
`);

const inviteOrganizationMemberMutation = parse(`
  mutation InviteOrganizationMember($organizationId: ID!, $username: String!) {
    inviteOrganizationMember(input: {
      organizationId: $organizationId
      username: $username
    }) {
      __typename
      ... on InviteOrganizationMemberPayload {
        membership {
          accepted
          notificationBadge { color count }
          organization { username }
          member { username }
        }
      }
    }
  }
`);

const markOrganizationNotificationsAsReadMutation = parse(`
  mutation MarkOrganizationNotificationsAsRead(
    $organizationId: ID!
    $readAt: DateTime
  ) {
    markOrganizationNotificationsAsRead(input: {
      organizationId: $organizationId
      readAt: $readAt
    }) {
      __typename
      ... on MarkOrganizationNotificationsAsReadPayload {
        badge {
          color
          count
        }
      }
    }
  }
`);

test("createOrganization creates an Organization account and admin membership", async () => {
  await withRollback(async (tx) => {
    const creator = await insertAccountWithActor(tx, {
      username: "graphqlorgcreator",
      name: "GraphQL Org Creator",
      email: "graphqlorgcreator@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, creator.account.id));

    const result = await execute({
      schema,
      document: createOrganizationMutation,
      variableValues: {
        input: {
          username: "graphqlorg",
          name: "GraphQL Org",
          bio: "Built from GraphQL",
        },
      },
      contextValue: makeUserContext(tx, creator.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const data = toPlainJson(result.data) as {
      createOrganization: {
        membership: {
          accepted: string | null;
        };
      };
    };
    assert.deepEqual(data, {
      createOrganization: {
        __typename: "CreateOrganizationPayload",
        organization: {
          username: "graphqlorg",
          kind: "ORGANIZATION",
          actor: { type: "ORGANIZATION" },
          inviter: { username: "graphqlorgcreator" },
        },
        membership: {
          role: "ADMIN",
          accepted: data.createOrganization.membership.accepted,
          organization: { username: "graphqlorg" },
          member: { username: "graphqlorgcreator" },
        },
      },
    });
    assert.ok(data.createOrganization.membership.accepted != null);

    const storedCreator = await tx.query.accountTable.findFirst({
      where: { id: creator.account.id },
    });
    assert.equal(storedCreator?.leftInvitations, 0);
  });
});

test("viewer exposes organization memberships and notification badge state", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "graphqlbadgeadmin",
      name: "GraphQL Badge Admin",
      email: "graphqlbadgeadmin@example.com",
    });
    const actor = await insertAccountWithActor(tx, {
      username: "graphqlbadgeactor",
      name: "GraphQL Badge Actor",
      email: "graphqlbadgeactor@example.com",
    });
    const otherActor = await insertAccountWithActor(tx, {
      username: "graphqlbadgeotheractor",
      name: "GraphQL Badge Other Actor",
      email: "graphqlbadgeotheractor@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "graphqlbadgeorg",
        name: "GraphQL Badge Org",
        bio: "",
      },
    );
    const created = [
      new Date("2026-04-15T09:00:00.000Z"),
      new Date("2026-04-15T08:00:00.000Z"),
    ];
    for (const [index, date] of created.entries()) {
      await tx.insert(notificationTable).values({
        id: crypto.randomUUID(),
        accountId: organization.id,
        type: "follow",
        actorIds: [index === 0 ? actor.actor.id : otherActor.actor.id],
        created: date,
      });
    }
    await getOrganizationNotificationBadge(
      tx,
      organization.id,
      admin.account.id,
      created[1],
    );

    const result = await execute({
      schema,
      document: viewerOrganizationStateQuery,
      contextValue: makeUserContext(tx, admin.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      viewer: {
        kind: "PERSONAL",
        organizationMemberships: [{
          role: "ADMIN",
          organization: {
            username: "graphqlbadgeorg",
            kind: "ORGANIZATION",
          },
          notificationBadge: {
            color: "RED",
            count: 1,
          },
        }],
      },
    });
  });
});

test("pending organization invitations expose no notification badge", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "graphqlinviteadmin",
      name: "GraphQL Invite Admin",
      email: "graphqlinviteadmin@example.com",
    });
    const member = await insertAccountWithActor(tx, {
      username: "graphqlinvitemember",
      name: "GraphQL Invite Member",
      email: "graphqlinvitemember@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "graphqlinviteorg",
        name: "GraphQL Invite Org",
        bio: "",
      },
    );

    const result = await execute({
      schema,
      document: inviteOrganizationMemberMutation,
      variableValues: {
        organizationId: encodeGlobalID("Account", organization.id),
        username: member.account.username,
      },
      contextValue: makeUserContext(tx, admin.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      inviteOrganizationMember: {
        __typename: "InviteOrganizationMemberPayload",
        membership: {
          accepted: null,
          notificationBadge: null,
          organization: { username: "graphqlinviteorg" },
          member: { username: "graphqlinvitemember" },
        },
      },
    });
  });
});

test("organization conversion request and acceptance turn a personal account into an organization", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlconvert",
      name: "GraphQL Convert",
      email: "graphqlconvert@example.com",
    });
    const admin = await insertAccountWithActor(tx, {
      username: "graphqlconvertadmin",
      name: "GraphQL Convert Admin",
      email: "graphqlconvertadmin@example.com",
    });

    const requestResult = await execute({
      schema,
      document: conversionMutation,
      variableValues: {
        accountId: encodeGlobalID("Account", account.account.id),
        adminUsername: admin.account.username,
        confirmationUsername: account.account.username,
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(requestResult.errors, undefined);
    const requestData = toPlainJson(requestResult.data) as {
      requestOrganizationConversion: {
        __typename: string;
        request: {
          uuid: string;
          account: {
            kind: string;
          };
        };
      };
    };
    assert.equal(
      requestData.requestOrganizationConversion.__typename,
      "RequestOrganizationConversionPayload",
    );
    assert.equal(
      requestData.requestOrganizationConversion.request.account.kind,
      "PERSONAL",
    );

    const requestId = requestData.requestOrganizationConversion.request.uuid;
    const acceptResult = await execute({
      schema,
      document: acceptConversionMutation,
      variableValues: { requestId },
      contextValue: makeUserContext(tx, admin.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(acceptResult.errors, undefined);
    assert.deepEqual(toPlainJson(acceptResult.data), {
      acceptOrganizationConversion: {
        __typename: "AcceptOrganizationConversionPayload",
        organization: {
          username: "graphqlconvert",
          kind: "ORGANIZATION",
          actor: { type: "ORGANIZATION" },
        },
        membership: {
          role: "ADMIN",
          organization: { username: "graphqlconvert" },
          member: { username: "graphqlconvertadmin" },
        },
      },
    });

    const memberships = await tx.select()
      .from(organizationMembershipTable)
      .where(eq(
        organizationMembershipTable.organizationAccountId,
        account.account.id,
      ));
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].memberAccountId, admin.account.id);
  });
});

test("markOrganizationNotificationsAsRead clamps future read markers", async () => {
  await withRollback(async (tx) => {
    const admin = await insertAccountWithActor(tx, {
      username: "graphqlmarkadmin",
      name: "GraphQL Mark Admin",
      email: "graphqlmarkadmin@example.com",
    });
    const actor = await insertAccountWithActor(tx, {
      username: "graphqlmarkactor",
      name: "GraphQL Mark Actor",
      email: "graphqlmarkactor@example.com",
    });
    await tx.update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, admin.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      admin.account,
      {
        username: "graphqlmarkorg",
        name: "GraphQL Mark Org",
        bio: "",
      },
    );
    await tx.insert(notificationTable).values({
      id: crypto.randomUUID(),
      accountId: organization.id,
      type: "follow",
      actorIds: [actor.actor.id],
      created: new Date(Date.now() + 60_000),
    });

    const result = await execute({
      schema,
      document: markOrganizationNotificationsAsReadMutation,
      variableValues: {
        organizationId: encodeGlobalID("Account", organization.id),
        readAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      contextValue: makeUserContext(tx, admin.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      markOrganizationNotificationsAsRead: {
        __typename: "MarkOrganizationNotificationsAsReadPayload",
        badge: {
          color: "RED",
          count: 1,
        },
      },
    });
  });
});
