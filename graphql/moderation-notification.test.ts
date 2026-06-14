import assert from "node:assert";
import test from "node:test";
import type { RequestContext } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import { createFlag } from "@hackerspub/models/flag";
import {
  createAppeal,
  takeModerationAction,
} from "@hackerspub/models/moderation";
import { accountTable, flagTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  type AuthenticatedAccount,
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const REASON = "This post contains harassment targeting another user.";

function quietFedCtx(tx: Transaction): RequestContext<ContextData> {
  const fedCtx = createFedCtx(tx);
  // deno-lint-ignore no-explicit-any
  (fedCtx as any).sendActivity = () => Promise.resolve();
  return fedCtx;
}

async function makeModerator(
  tx: Transaction,
  values: { username: string; name: string; email: string },
): Promise<AuthenticatedAccount> {
  // Isolate from moderators outside the transaction.
  await tx.update(accountTable).set({ moderator: false });
  const { account } = await insertAccountWithActor(tx, values);
  await tx.update(accountTable).set({ moderator: true }).where(
    eq(accountTable.id, account.id),
  );
  return { ...account, moderator: true };
}

async function seedModeratedCase(tx: Transaction) {
  const fedCtx = quietFedCtx(tx);
  const moderator = await makeModerator(tx, {
    username: "mod",
    name: "Mod",
    email: "mod@example.com",
  });
  const reporter = await insertAccountWithActor(tx, {
    username: "reporter",
    name: "Reporter",
    email: "reporter@example.com",
  });
  const reported = await insertAccountWithActor(tx, {
    username: "reported",
    name: "Reported",
    email: "reported@example.com",
  });
  const { post } = await insertNotePost(tx, { account: reported.account });
  const flag = await createFlag(tx, {
    reporter: reporter.actor,
    targetActor: reported.actor,
    targetPost: post,
    reason: REASON,
  });
  assert.ok(flag != null);
  return { fedCtx, moderator, reporter, reported, post, flag };
}

const notificationsQuery = parse(`
  query Notifications($username: String!) {
    accountByUsername(username: $username) {
      unreadModerationNotificationCount
      moderationNotifications(first: 10) {
        edges {
          node {
            id
            uuid
            type
            read
            sanction { uuid actionType messageToUser }
          }
        }
      }
    }
  }
`);

const markReadMutation = parse(`
  mutation MarkRead($upToId: ID) {
    markModerationNotificationsRead(upToId: $upToId)
  }
`);

const statisticsQuery = parse(`
  query Stats {
    moderationStatistics {
      totalReports
      processedReports
      averageProcessingHours
      actionDistribution { actionType count }
      topViolatedProvisions { provision count }
      llmDivergence { compared diverged }
    }
  }
`);

const provisionsQuery = parse(`
  query Provisions($locale: Locale) {
    codeOfConductProvisions(locale: $locale) {
      id
      section
      title
      text
    }
  }
`);

test("moderation notifications reach the right accounts", async () => {
  await withRollback(async (tx) => {
    const { fedCtx, moderator, reported, flag } = await seedModeratedCase(tx);
    const action = await takeModerationAction(fedCtx, {
      caseId: flag.caseId,
      moderator,
      actionType: "warning",
      violatedProvisions: ["2.3"],
      rationale: "Internal rationale.",
      messageToUser: "Please review our code of conduct.",
    });
    assert.ok(action != null);

    // The moderator sees their flag_received notification:
    const modResult = await execute({
      schema,
      document: notificationsQuery,
      variableValues: { username: "mod" },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(modResult.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const modAccount = (modResult.data as any)?.accountByUsername;
    assert.equal(modAccount?.unreadModerationNotificationCount, 1);
    const modEdges = modAccount?.moderationNotifications?.edges;
    assert.equal(modEdges?.length, 1);
    assert.equal(modEdges[0].node.type, "FLAG_RECEIVED");
    assert.equal(modEdges[0].node.sanction, null);

    // The reported user sees the action_taken notification with the
    // sanitized sanction:
    const targetResult = await execute({
      schema,
      document: notificationsQuery,
      variableValues: { username: "reported" },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(targetResult.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const targetAccount = (targetResult.data as any)?.accountByUsername;
    const targetEdges = targetAccount?.moderationNotifications?.edges;
    assert.equal(targetEdges?.length, 1);
    assert.equal(targetEdges[0].node.type, "ACTION_TAKEN");
    assert.equal(targetEdges[0].node.sanction?.uuid, action.id);
    assert.equal(targetEdges[0].node.sanction?.actionType, "WARNING");
    const raw = JSON.stringify(targetResult.data);
    assert.ok(!raw.includes("Internal rationale."));
    assert.ok(!raw.includes(REASON));

    // A third party cannot read someone else's notifications:
    const other = await insertAccountWithActor(tx, {
      username: "other",
      name: "Other",
      email: "other@example.com",
    });
    const foreign = await execute({
      schema,
      document: notificationsQuery,
      variableValues: { username: "reported" },
      contextValue: makeUserContext(tx, other.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (foreign.data as any)?.accountByUsername
        ?.moderationNotifications ?? null,
      null,
    );
  });
});

test("markModerationNotificationsRead marks the viewer's queue", async () => {
  await withRollback(async (tx) => {
    const { fedCtx, moderator, flag } = await seedModeratedCase(tx);
    const action = await takeModerationAction(fedCtx, {
      caseId: flag.caseId,
      moderator,
      actionType: "warning",
      violatedProvisions: ["2.3"],
      rationale: "Rationale.",
    });
    assert.ok(action != null);
    const marked = await execute({
      schema,
      document: markReadMutation,
      variableValues: {},
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(marked.errors, undefined);
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (marked.data as any)?.markModerationNotificationsRead,
      1,
    );
    const after = await execute({
      schema,
      document: notificationsQuery,
      variableValues: { username: "mod" },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (after.data as any)?.accountByUsername
        ?.unreadModerationNotificationCount,
      0,
    );
  });
});

test("moderationStatistics aggregates the queue for moderators", async () => {
  await withRollback(async (tx) => {
    const { fedCtx, moderator, reported, flag } = await seedModeratedCase(
      tx,
    );
    // Give the report a synthetic LLM analysis diverging from the
    // confirmed provisions:
    await tx.update(flagTable)
      .set({
        llmAnalysis: {
          matches: [
            { provision: "3.2", confidence: 0.8, rationale: "Spam-like." },
          ],
          summary: "Probably spam.",
          model: "test",
          analyzedAt: new Date().toISOString(),
        },
      })
      .where(eq(flagTable.id, flag.id));
    const action = await takeModerationAction(fedCtx, {
      caseId: flag.caseId,
      moderator,
      actionType: "warning",
      violatedProvisions: ["2.3"],
      rationale: "Rationale.",
    });
    assert.ok(action != null);

    const denied = await execute({
      schema,
      document: statisticsQuery,
      variableValues: {},
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((denied.data as any)?.moderationStatistics ?? null, null);

    const result = await execute({
      schema,
      document: statisticsQuery,
      variableValues: {},
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const stats = (result.data as any)?.moderationStatistics;
    assert.equal(stats?.totalReports, 1);
    assert.equal(stats?.processedReports, 1);
    assert.ok(stats?.averageProcessingHours != null);
    assert.deepEqual(stats?.actionDistribution, [
      { actionType: "WARNING", count: 1 },
    ]);
    assert.deepEqual(stats?.topViolatedProvisions, [
      { provision: "2.3", count: 1 },
    ]);
    // The LLM suggested 3.2 but the moderator confirmed 2.3: divergence.
    assert.deepEqual(stats?.llmDivergence, { compared: 1, diverged: 1 });
  });
});

test("codeOfConductProvisions is public and localized", async () => {
  await withRollback(async (tx) => {
    const english = await execute({
      schema,
      document: provisionsQuery,
      variableValues: {},
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(english.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const provisions = (english.data as any)?.codeOfConductProvisions;
    assert.ok(provisions?.length > 0);
    assert.equal(provisions[0].id, "1.1");
    assert.equal(provisions[0].title, "Our Values");

    const korean = await execute({
      schema,
      document: provisionsQuery,
      variableValues: { locale: "ko" },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const koProvisions = (korean.data as any)?.codeOfConductProvisions;
    assert.equal(koProvisions?.[0]?.id, "1.1");
    assert.notEqual(koProvisions?.[0]?.title, "Our Values");
  });
});

test("appeal notifications round-trip", async () => {
  await withRollback(async (tx) => {
    const { fedCtx, moderator, reported, flag } = await seedModeratedCase(
      tx,
    );
    const action = await takeModerationAction(fedCtx, {
      caseId: flag.caseId,
      moderator,
      actionType: "warning",
      violatedProvisions: ["2.3"],
      rationale: "Rationale.",
    });
    assert.ok(action != null);
    const appeal = await createAppeal(tx, {
      actionId: action.id,
      appellant: reported.account,
      reason: "Unjust decision.",
    });
    assert.ok(appeal != null);
    const appealNotificationsQuery = parse(`
      query AppealNotifications($username: String!) {
        accountByUsername(username: $username) {
          moderationNotifications(first: 10) {
            edges {
              node {
                type
                appeal { uuid status }
              }
            }
          }
        }
      }
    `);
    const modResult = await execute({
      schema,
      document: appealNotificationsQuery,
      variableValues: { username: "mod" },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const types = ((modResult.data as any)?.accountByUsername
      ?.moderationNotifications?.edges ?? [])
      // deno-lint-ignore no-explicit-any
      .map((edge: any) => edge.node.type);
    assert.ok(types.includes("APPEAL_RECEIVED"));
  });
});
