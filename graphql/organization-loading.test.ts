import assert from "node:assert/strict";
import test from "node:test";
import { getOrganizationNotificationBadges } from "@hackerspub/models/organization";
import {
  notificationTable,
  organizationMembershipTable,
  organizationNotificationReadTable,
} from "@hackerspub/models/schema";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import { postgres } from "../test/database.ts";
import {
  insertAccountWithActor,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

test("organization membership accounts load in one batch", async (t) => {
  await withRollback(async (tx) => {
    const member = await insertAccountWithActor(tx, {
      username: "orgbatchmember",
      name: "Organization Member",
      email: "orgbatchmember@example.com",
    });
    for (let index = 0; index < 6; index++) {
      const organization = await insertAccountWithActor(tx, {
        username: `orgbatch${index}`,
        name: `Organization ${index}`,
        email: `orgbatch${index}@example.com`,
        kind: "organization",
        type: "Organization",
      });
      await tx.insert(organizationMembershipTable).values({
        organizationAccountId: organization.account.id,
        memberAccountId: member.account.id,
        role: "admin",
        invitedById: member.account.id,
        accepted: new Date(),
      });
    }
    const accountQueries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => {
      if (query.includes('from "account" as "d0"')) accountQueries.push(query);
    };
    try {
      const result = await execute({
        schema,
        document: parse(`{
          viewer { organizationMemberships {
            organization { username kind }
            member { username kind }
          } }
        }`),
        contextValue: makeUserContext(tx, member.account),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      const data = toPlainJson(result.data) as {
        viewer: {
          organizationMemberships: {
            organization: { username: string; kind: string };
            member: { username: string; kind: string };
          }[];
        };
      };
      assert.deepEqual(
        data.viewer.organizationMemberships.toSorted((a, b) =>
          a.organization.username.localeCompare(b.organization.username),
        ),
        Array.from({ length: 6 }, (_, index) => ({
          organization: { username: `orgbatch${index}`, kind: "ORGANIZATION" },
          member: { username: member.account.username, kind: "PERSONAL" },
        })),
      );
      t.diagnostic(
        `Six organizations emitted ${accountQueries.length} account queries`,
      );
      assert(accountQueries.length <= 4, accountQueries.join("\n"));
      // The viewer lookup, moderator check and Pothos field projection have
      // fixed overhead; membership accounts and their actors share one query.
      assert.equal(
        accountQueries.filter((query) =>
          query.includes('"actor"."r" as "actor"'),
        ).length,
        1,
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("organization badges batch counts and preserve red, gray and empty states", async (t) => {
  await withRollback(async (tx) => {
    const member = await insertAccountWithActor(tx, {
      username: "badgegroupmember",
      name: "Badge Member",
      email: "badgegroupmember@example.com",
    });
    const reader = await insertAccountWithActor(tx, {
      username: "badgegroupreader",
      name: "Badge Reader",
      email: "badgegroupreader@example.com",
    });
    for (let index = 0; index < 6; index++) {
      const organization = await insertAccountWithActor(tx, {
        username: `badgegroup${index}`,
        name: `Badge Group ${index}`,
        email: `badgegroup${index}@example.com`,
        kind: "organization",
        type: "Organization",
      });
      await tx.insert(organizationMembershipTable).values(
        [member, reader].map((account) => ({
          organizationAccountId: organization.account.id,
          memberAccountId: account.account.id,
          role: "admin" as const,
          invitedById: member.account.id,
          accepted: new Date("2026-04-15T10:00Z"),
          created: new Date(`2026-04-15T10:0${index}Z`),
        })),
      );
      await tx.insert(notificationTable).values([
        {
          id: crypto.randomUUID(),
          accountId: organization.account.id,
          type: "follow" as const,
          actorIds: [member.actor.id],
          created: new Date("2026-04-15T12:00Z"),
        },
        {
          id: crypto.randomUUID(),
          accountId: organization.account.id,
          type: "follow" as const,
          actorIds: [],
          created: new Date("2026-04-15T14:00Z"),
        },
      ]);
      if (index >= 2) {
        await tx.insert(organizationNotificationReadTable).values({
          organizationAccountId: organization.account.id,
          memberAccountId: index >= 4 ? member.account.id : reader.account.id,
          read: new Date("2026-04-15T13:00Z"),
        });
      }
    }
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => {
      queries.push(query);
    };
    try {
      const result = await execute({
        schema,
        document: parse(`{
        viewer { organizationMemberships { notificationBadge { color count } } }
      }`),
        contextValue: makeUserContext(tx, member.account),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      assert.deepEqual(toPlainJson(result.data), {
        viewer: {
          organizationMemberships: [
            { notificationBadge: { color: null, count: 0 } },
            { notificationBadge: { color: null, count: 0 } },
            { notificationBadge: { color: "GRAY", count: 1 } },
            { notificationBadge: { color: "GRAY", count: 1 } },
            { notificationBadge: { color: "RED", count: 1 } },
            { notificationBadge: { color: "RED", count: 1 } },
          ],
        },
      });
      const counts = queries.filter((query) =>
        query.includes('from "notification"'),
      ).length;
      const memberships = queries.filter((query) =>
        query.includes('from "organization_membership" as "d0"'),
      ).length;
      t.diagnostic(
        `Six badges emitted ${counts} notification count queries and ${memberships} membership queries`,
      );
      assert.equal(counts, 1);
      assert(memberships > 0 && memberships <= 2);
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("badge batches omit pending and unauthorized organizations", async () => {
  await withRollback(async (tx) => {
    const member = await insertAccountWithActor(tx, {
      username: "batchbadgescope",
      name: "Badge Scope",
      email: "batchbadgescope@example.com",
    });
    const organizations: Awaited<ReturnType<typeof insertAccountWithActor>>[] =
      [];
    for (let index = 0; index < 3; index++) {
      const organization = await insertAccountWithActor(tx, {
        username: `batchbadgescope${index}`,
        name: `Organization ${index}`,
        email: `batchbadgescope${index}@example.com`,
        kind: "organization",
        type: "Organization",
      });
      organizations.push(organization);
      if (index < 2) {
        await tx.insert(organizationMembershipTable).values({
          organizationAccountId: organization.account.id,
          memberAccountId: member.account.id,
          role: "member",
          invitedById: member.account.id,
          accepted: index === 0 ? new Date() : null,
        });
      }
    }
    const badges = await getOrganizationNotificationBadges(
      tx,
      organizations.map((organization) => organization.account.id),
      member.account.id,
    );
    assert.equal(badges.size, 1);
    assert.deepEqual(badges.get(organizations[0].account.id), {
      color: null,
      count: 0,
    });
  });
});
