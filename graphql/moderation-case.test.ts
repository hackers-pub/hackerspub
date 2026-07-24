import assert from "node:assert";
import test from "node:test";
import { createFlag } from "@hackerspub/models/flag";
import type { Transaction } from "@hackerspub/models/db";
import { getModerationNotifications } from "@hackerspub/models/moderation-notification";
import { accountEmailTable, accountTable } from "@hackerspub/models/schema";
import { encodeGlobalID } from "@pothos/plugin-relay";
import type { Message } from "@upyo/core";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  type AuthenticatedAccount,
  createTestEmailTransport,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const REASON = "This post contains harassment targeting another user.";

async function makeModerator(
  tx: Transaction,
  values: { username: string; name: string; email: string },
): Promise<AuthenticatedAccount> {
  const { account } = await insertAccountWithActor(tx, values);
  await tx
    .update(accountTable)
    .set({ moderator: true })
    .where(eq(accountTable.id, account.id));
  return { ...account, moderator: true };
}

async function seedCase(tx: Transaction, reporters = 1) {
  const author = await insertAccountWithActor(tx, {
    username: "author",
    name: "Author",
    email: "author@example.com",
  });
  const { post } = await insertNotePost(tx, {
    account: author.account,
    content: "Offensive content",
  });
  let caseId: string | undefined;
  for (let i = 0; i < reporters; i++) {
    const reporter = await insertAccountWithActor(tx, {
      username: `reporter${i}`,
      name: `Reporter ${i}`,
      email: `reporter${i}@example.com`,
    });
    const flag = await createFlag(tx, {
      reporter: reporter.actor,
      targetActor: author.actor,
      targetPost: post,
      reason: `${REASON} (${i})`,
    });
    assert.ok(flag != null);
    caseId = flag.caseId;
  }
  assert.ok(caseId != null);
  return { author, post, caseId };
}

const casesQuery = parse(`
  query Cases($status: FlagStatus, $minReportCount: Int, $search: String) {
    moderationCases(
      first: 10
      status: $status
      minReportCount: $minReportCount
      search: $search
    ) {
      edges {
        node {
          uuid
          status
          reportCount
          targetActor { handle }
          targetPostIri
          flags(first: 10) {
            edges { node { reason snapshot { contentHtml } } }
          }
        }
      }
    }
  }
`);

const caseByUuidQuery = parse(`
  query CaseByUuid($uuid: UUID!) {
    flagCaseByUuid(uuid: $uuid) {
      id
      uuid
      status
      reportCount
      violationHistory { uuid }
      actions { uuid actionType }
    }
  }
`);

const takeActionMutation = parse(`
  mutation TakeAction(
    $caseId: ID!
    $actionType: FlagActionType!
    $violatedProvisions: [String!]
    $rationale: String!
    $messageToUser: String
    $suspensionStarts: DateTime
    $suspensionEnds: DateTime
  ) {
    takeModerationAction(
      caseId: $caseId
      actionType: $actionType
      violatedProvisions: $violatedProvisions
      rationale: $rationale
      messageToUser: $messageToUser
      suspensionStarts: $suspensionStarts
      suspensionEnds: $suspensionEnds
    ) {
      __typename
      ... on FlagAction {
        uuid
        actionType
        violatedProvisions
        case { uuid status }
      }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
      ... on InvalidInputError { inputPath }
    }
  }
`);

const assignMutation = parse(`
  mutation Assign($caseId: ID!, $moderatorId: ID) {
    assignFlagCase(caseId: $caseId, moderatorId: $moderatorId) {
      __typename
      ... on FlagCase {
        status
        assignedModerator { username }
      }
      ... on NotAuthorizedError { notAuthorized }
    }
  }
`);

test("moderationCases is null for non-moderators and lists for moderators", async () => {
  await withRollback(async (tx) => {
    const { caseId } = await seedCase(tx, 2);
    const moderator = await makeModerator(tx, {
      username: "mod",
      name: "Mod",
      email: "mod@example.com",
    });
    const plain = await insertAccountWithActor(tx, {
      username: "plain",
      name: "Plain",
      email: "plain@example.com",
    });

    const denied = await execute({
      schema,
      document: casesQuery,
      variableValues: {},
      contextValue: makeUserContext(tx, plain.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((denied.data as any)?.moderationCases ?? null, null);

    const result = await execute({
      schema,
      document: casesQuery,
      variableValues: {},
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const edges = (result.data as any)?.moderationCases?.edges;
    assert.equal(edges?.length, 1);
    const node = edges[0].node;
    assert.equal(node.uuid, caseId);
    assert.equal(node.status, "PENDING");
    assert.equal(node.reportCount, 2);
    assert.equal(node.flags.edges.length, 2);
    assert.match(node.flags.edges[0].node.reason, /harassment/);
    assert.match(
      node.flags.edges[0].node.snapshot.contentHtml,
      /Offensive content/,
    );

    // Filters:
    const none = await execute({
      schema,
      document: casesQuery,
      variableValues: { status: "RESOLVED" },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((none.data as any)?.moderationCases?.edges?.length, 0);

    const priority = await execute({
      schema,
      document: casesQuery,
      variableValues: { minReportCount: 3 },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((priority.data as any)?.moderationCases?.edges?.length, 0);

    const found = await execute({
      schema,
      document: casesQuery,
      variableValues: { search: "author" },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((found.data as any)?.moderationCases?.edges?.length, 1);

    const missed = await execute({
      schema,
      document: casesQuery,
      variableValues: { search: "nonexistent" },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((missed.data as any)?.moderationCases?.edges?.length, 0);
  });
});

test("flagCaseByUuid resolves for moderators only", async () => {
  await withRollback(async (tx) => {
    const { caseId } = await seedCase(tx);
    const moderator = await makeModerator(tx, {
      username: "mod",
      name: "Mod",
      email: "mod@example.com",
    });
    const plain = await insertAccountWithActor(tx, {
      username: "plain",
      name: "Plain",
      email: "plain@example.com",
    });

    const result = await execute({
      schema,
      document: caseByUuidQuery,
      variableValues: { uuid: caseId },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const flagCase = (result.data as any)?.flagCaseByUuid;
    assert.equal(flagCase?.uuid, caseId);
    assert.deepEqual(flagCase?.actions, []);
    assert.deepEqual(flagCase?.violationHistory, []);

    const denied = await execute({
      schema,
      document: caseByUuidQuery,
      variableValues: { uuid: caseId },
      contextValue: makeUserContext(tx, plain.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((denied.data as any)?.flagCaseByUuid ?? null, null);
  });
});

test("assignFlagCase assigns and bumps the status", async () => {
  await withRollback(async (tx) => {
    const { caseId } = await seedCase(tx);
    const moderator = await makeModerator(tx, {
      username: "mod",
      name: "Mod",
      email: "mod@example.com",
    });
    const caseGid = encodeGlobalID("FlagCase", caseId);
    const modGid = encodeGlobalID("Account", moderator.id);
    const result = await execute({
      schema,
      document: assignMutation,
      variableValues: { caseId: caseGid, moderatorId: modGid },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const assigned = (result.data as any)?.assignFlagCase;
    assert.equal(assigned?.__typename, "FlagCase");
    assert.equal(assigned?.status, "REVIEWING");
    assert.equal(assigned?.assignedModerator?.username, "mod");

    // Non-moderators are rejected:
    const plain = await insertAccountWithActor(tx, {
      username: "plain",
      name: "Plain",
      email: "plain@example.com",
    });
    const denied = await execute({
      schema,
      document: assignMutation,
      variableValues: { caseId: caseGid, moderatorId: modGid },
      contextValue: makeUserContext(tx, plain.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (denied.data as any)?.assignFlagCase?.__typename,
      "NotAuthorizedError",
    );
  });
});

test("takeModerationAction records a warning and emails the user", async () => {
  await withRollback(async (tx) => {
    const { caseId } = await seedCase(tx);
    const moderator = await makeModerator(tx, {
      username: "mod",
      name: "Mod",
      email: "mod@example.com",
    });
    const email = createTestEmailTransport();
    const result = await execute({
      schema,
      document: takeActionMutation,
      variableValues: {
        caseId: encodeGlobalID("FlagCase", caseId),
        actionType: "WARNING",
        violatedProvisions: ["2.3"],
        rationale: "First offense; education preferred.",
        messageToUser: "Please review our code of conduct on harassment.",
      },
      contextValue: makeUserContext(tx, moderator, {
        email: email.transport,
      }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const action = (result.data as any)?.takeModerationAction;
    assert.equal(action?.__typename, "FlagAction");
    assert.equal(action?.actionType, "WARNING");
    assert.deepEqual(action?.violatedProvisions, ["2.3"]);
    assert.equal(action?.case?.status, "RESOLVED");

    assert.equal(email.messages.length, 1);
    const message = email.messages[0] as Message;
    const recipients = message.recipients.map((r) => r.address);
    assert.deepEqual(recipients, ["author@example.com"]);
    const body = message.content.text ?? "";
    assert.ok(body.length > 0);
    assert.match(body, /2\.3/);
    assert.match(body, /Please review our code of conduct on harassment\./);
    assert.match(body, /\/@author\/settings\/moderation/);
    assert.ok(!body.includes("/settings/sanctions"));
    // The reporter's wording must never reach the reported user:
    assert.ok(!body.includes(REASON));
  });
});

test("dismissals reject violated provisions", async () => {
  await withRollback(async (tx) => {
    const { caseId } = await seedCase(tx);
    const moderator = await makeModerator(tx, {
      username: "mod",
      name: "Mod",
      email: "mod@example.com",
    });
    const result = await execute({
      schema,
      document: takeActionMutation,
      variableValues: {
        caseId: encodeGlobalID("FlagCase", caseId),
        actionType: "DISMISS",
        violatedProvisions: ["2.3"],
        rationale: "Dismissing, but with stray provisions ticked.",
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const data = (result.data as any)?.takeModerationAction;
    assert.equal(data?.__typename, "InvalidInputError");
    assert.equal(data?.inputPath, "violatedProvisions");
    // The case stays open:
    const flagCase = await tx.query.flagCaseTable.findFirst({
      where: {
        id: caseId as `${string}-${string}-${string}-${string}-${string}`,
      },
    });
    assert.equal(flagCase?.status, "pending");
  });
});

test("a reported moderator cannot access or act on their own case", async () => {
  await withRollback(async (tx) => {
    const targetMod = await makeModerator(tx, {
      username: "targetmod",
      name: "Target Mod",
      email: "targetmod@example.com",
    });
    const otherMod = await makeModerator(tx, {
      username: "othermod",
      name: "Other Mod",
      email: "othermod@example.com",
    });
    const reporter = await insertAccountWithActor(tx, {
      username: "modreporter",
      name: "Mod Reporter",
      email: "modreporter@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: targetMod,
      content: "A moderator's offensive post",
    });
    const flag = await createFlag(tx, {
      reporter: reporter.actor,
      targetActor: targetMod.actor,
      targetPost: post,
      reason: REASON,
    });
    assert.ok(flag != null);

    // The reported moderator's queue excludes their own case:
    const queue = await execute({
      schema,
      document: casesQuery,
      variableValues: {},
      contextValue: makeUserContext(tx, targetMod),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const edges = (queue.data as any)?.moderationCases?.edges ?? [];
    assert.ok(
      // deno-lint-ignore no-explicit-any
      edges.every((edge: any) => edge.node.uuid !== flag.caseId),
    );

    // Direct lookups behave as if the case does not exist:
    const byUuid = await execute({
      schema,
      document: caseByUuidQuery,
      variableValues: { uuid: flag.caseId },
      contextValue: makeUserContext(tx, targetMod),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((byUuid.data as any)?.flagCaseByUuid ?? null, null);
    const nodeQuery = parse(`
      query CaseNode($id: ID!) {
        node(id: $id) { __typename }
      }
    `);
    const byNode = await execute({
      schema,
      document: nodeQuery,
      variableValues: { id: encodeGlobalID("FlagCase", flag.caseId) },
      contextValue: makeUserContext(tx, targetMod),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((byNode.data as any)?.node ?? null, null);

    // Acting on the own case is rejected like an unknown case:
    const acted = await execute({
      schema,
      document: takeActionMutation,
      variableValues: {
        caseId: encodeGlobalID("FlagCase", flag.caseId),
        actionType: "DISMISS",
        rationale: "Trying to dismiss the report against myself.",
      },
      contextValue: makeUserContext(tx, targetMod),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (acted.data as any)?.takeModerationAction?.__typename,
      "InvalidInputError",
    );

    // The reported moderator got no flag_received notification; the
    // other moderator did:
    const targetNotifications = await getModerationNotifications(
      tx,
      targetMod.id,
    );
    assert.ok(targetNotifications.every((n) => n.type !== "flag_received"));
    const otherNotifications = await getModerationNotifications(
      tx,
      otherMod.id,
    );
    assert.ok(
      otherNotifications.some(
        (n) => n.type === "flag_received" && n.caseId === flag.caseId,
      ),
    );

    // Another moderator still has full access:
    const otherView = await execute({
      schema,
      document: caseByUuidQuery,
      variableValues: { uuid: flag.caseId },
      contextValue: makeUserContext(tx, otherMod),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((otherView.data as any)?.flagCaseByUuid?.uuid, flag.caseId);
  });
});

test("sanction emails go to every verified address", async () => {
  await withRollback(async (tx) => {
    const { caseId, author } = await seedCase(tx);
    const now = new Date();
    await tx.insert(accountEmailTable).values([
      {
        email: "author-backup@example.com",
        accountId: author.account.id,
        public: false,
        verified: now,
        created: now,
      },
      // Unverified addresses must not receive moderation mail:
      {
        email: "author-unverified@example.com",
        accountId: author.account.id,
        public: false,
        verified: null,
        created: now,
      },
    ]);
    const moderator = await makeModerator(tx, {
      username: "mod",
      name: "Mod",
      email: "mod@example.com",
    });
    const email = createTestEmailTransport();
    const result = await execute({
      schema,
      document: takeActionMutation,
      variableValues: {
        caseId: encodeGlobalID("FlagCase", caseId),
        actionType: "WARNING",
        violatedProvisions: ["2.3"],
        rationale: "First offense; education preferred.",
        messageToUser: "Please review our code of conduct on harassment.",
      },
      contextValue: makeUserContext(tx, moderator, {
        email: email.transport,
      }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const recipients = email.messages
      .flatMap((message) =>
        (message as Message).recipients.map((r) => r.address),
      )
      .sort();
    assert.deepEqual(recipients, [
      "author-backup@example.com",
      "author@example.com",
    ]);
  });
});

const takeActionWithForwardMutation = parse(`
  mutation TakeActionFwd(
    $caseId: ID!
    $actionType: FlagActionType!
    $violatedProvisions: [String!]
    $rationale: String!
    $forwardSummary: String
  ) {
    takeModerationAction(
      caseId: $caseId
      actionType: $actionType
      violatedProvisions: $violatedProvisions
      rationale: $rationale
      forwardSummary: $forwardSummary
    ) {
      __typename
      ... on FlagAction { actionType }
      ... on InvalidInputError { inputPath }
    }
  }
`);

const forwardingEnabledQuery = parse(`
  query ForwardingEnabled($uuid: UUID!) {
    flagCaseByUuid(uuid: $uuid) { forwardingEnabled }
  }
`);

test("takeModerationAction requires a forward summary for forwarded actions", async () => {
  await withRollback(async (tx) => {
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
    const target = await insertRemoteActor(tx, {
      username: "bad",
      name: "Bad Actor",
      host: "remote.example",
    });
    const flag = await createFlag(tx, {
      reporter: reporter.actor,
      targetActor: target,
      reason: "This remote user is harassing people here.",
      forwardToRemote: true,
    });
    assert.ok(flag != null);
    const caseGid = encodeGlobalID("FlagCase", flag.caseId);

    // The case reports forwarding is enabled (target remote + opt-in):
    const enabled = await execute({
      schema,
      document: forwardingEnabledQuery,
      variableValues: { uuid: flag.caseId },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (enabled.data as any)?.flagCaseByUuid?.forwardingEnabled,
      true,
    );

    // A non-dismiss action without a summary is rejected, so the internal
    // rationale can never be forwarded as the Flag's content:
    const missing = await execute({
      schema,
      document: takeActionWithForwardMutation,
      variableValues: {
        caseId: caseGid,
        actionType: "WARNING",
        violatedProvisions: ["2.3"],
        rationale: "Internal note that must not be forwarded.",
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (missing.data as any)?.takeModerationAction?.inputPath,
      "forwardSummary",
    );

    // The case stays open, so the action can be retried with a summary:
    const withSummary = await execute({
      schema,
      document: takeActionWithForwardMutation,
      variableValues: {
        caseId: caseGid,
        actionType: "WARNING",
        violatedProvisions: ["2.3"],
        rationale: "Internal note that must not be forwarded.",
        forwardSummary: "Repeated harassment of our members.",
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (withSummary.data as any)?.takeModerationAction?.__typename,
      "FlagAction",
    );
  });
});

test("takeModerationAction allows dismissing a forwarded case without a summary", async () => {
  await withRollback(async (tx) => {
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
    const target = await insertRemoteActor(tx, {
      username: "maybe",
      name: "Maybe Fine",
      host: "remote.example",
    });
    const flag = await createFlag(tx, {
      reporter: reporter.actor,
      targetActor: target,
      reason: "Possibly a false alarm.",
      forwardToRemote: true,
    });
    assert.ok(flag != null);

    const dismissed = await execute({
      schema,
      document: takeActionWithForwardMutation,
      variableValues: {
        caseId: encodeGlobalID("FlagCase", flag.caseId),
        actionType: "DISMISS",
        rationale: "No violation found.",
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (dismissed.data as any)?.takeModerationAction?.__typename,
      "FlagAction",
    );
  });
});

test("takeModerationAction validates input and authorization", async () => {
  await withRollback(async (tx) => {
    const { caseId } = await seedCase(tx);
    const moderator = await makeModerator(tx, {
      username: "mod",
      name: "Mod",
      email: "mod@example.com",
    });
    const plain = await insertAccountWithActor(tx, {
      username: "plain",
      name: "Plain",
      email: "plain@example.com",
    });
    const caseGid = encodeGlobalID("FlagCase", caseId);

    const denied = await execute({
      schema,
      document: takeActionMutation,
      variableValues: {
        caseId: caseGid,
        actionType: "WARNING",
        violatedProvisions: ["2.3"],
        rationale: "Nope.",
      },
      contextValue: makeUserContext(tx, plain.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (denied.data as any)?.takeModerationAction?.__typename,
      "NotAuthorizedError",
    );

    const noProvisions = await execute({
      schema,
      document: takeActionMutation,
      variableValues: {
        caseId: caseGid,
        actionType: "WARNING",
        rationale: "Missing provisions.",
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (noProvisions.data as any)?.takeModerationAction?.inputPath,
      "violatedProvisions",
    );

    const badWindow = await execute({
      schema,
      document: takeActionMutation,
      variableValues: {
        caseId: caseGid,
        actionType: "SUSPEND",
        violatedProvisions: ["2.3"],
        rationale: "Bad window.",
        suspensionStarts: new Date().toISOString(),
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (badWindow.data as any)?.takeModerationAction?.inputPath,
      "suspensionEnds",
    );

    // A dismissal without a message resolves the case without email:
    const email = createTestEmailTransport();
    const dismissed = await execute({
      schema,
      document: takeActionMutation,
      variableValues: {
        caseId: caseGid,
        actionType: "DISMISS",
        rationale: "Not a violation.",
      },
      contextValue: makeUserContext(tx, moderator, {
        email: email.transport,
      }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (dismissed.data as any)?.takeModerationAction?.__typename,
      "FlagAction",
    );
    assert.equal(email.messages.length, 0);

    // The case is now closed; acting again fails:
    const again = await execute({
      schema,
      document: takeActionMutation,
      variableValues: {
        caseId: caseGid,
        actionType: "WARNING",
        violatedProvisions: ["2.3"],
        rationale: "Too late.",
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (again.data as any)?.takeModerationAction?.inputPath,
      "caseId",
    );
  });
});
