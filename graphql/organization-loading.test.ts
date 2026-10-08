import assert from "node:assert/strict";
import test from "node:test";
import { organizationMembershipTable } from "@hackerspub/models/schema";
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
