import assert from "node:assert";
import test from "node:test";
import type { RequestContext } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import { createArticle } from "@hackerspub/models/article";
import { createFlag } from "@hackerspub/models/flag";
import { createQuestion } from "@hackerspub/models/question";
import { takeModerationAction } from "@hackerspub/models/moderation";
import {
  accountTable,
  actorTable,
  type FlagActionType,
} from "@hackerspub/models/schema";
import { createSigninToken } from "@hackerspub/models/signin";
import { getModerationActionEmail } from "./moderation-email.ts";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  type AuthenticatedAccount,
  createFedCtx,
  createTestKv,
  insertAccountWithActor,
  insertNotePost,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const HOUR = 60 * 60 * 1000;
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
  const { account } = await insertAccountWithActor(tx, values);
  await tx.update(accountTable).set({ moderator: true }).where(
    eq(accountTable.id, account.id),
  );
  return { ...account, moderator: true };
}

async function sanction(
  tx: Transaction,
  actionType: FlagActionType = "warning",
) {
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
  const action = await takeModerationAction(fedCtx, {
    caseId: flag.caseId,
    moderator,
    actionType,
    violatedProvisions: actionType === "dismiss" ? undefined : ["2.3"],
    rationale: "Internal moderator-only rationale.",
    messageToUser: "Please review our code of conduct.",
    ...(actionType === "suspend"
      ? {
        suspensionStarts: new Date(Date.now() - HOUR),
        suspensionEnds: new Date(Date.now() + 30 * 24 * HOUR),
      }
      : {}),
  });
  assert.ok(action != null);
  return { moderator, reporter, reported, post, action };
}

const sanctionsQuery = parse(`
  query Sanctions($username: String!) {
    accountByUsername(username: $username) {
      sanctions {
        uuid
        actionType
        violatedProvisions
        messageToUser
        targetPostIri
        appealableUntil
        appeal { uuid status result }
      }
    }
  }
`);

const appealMutation = parse(`
  mutation Appeal($sanctionId: UUID!, $reason: String!, $context: String) {
    appealModerationAction(
      sanctionId: $sanctionId
      reason: $reason
      additionalContext: $context
    ) {
      __typename
      ... on FlagAppeal {
        id
        uuid
        status
        result
        reason
      }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on InvalidInputError { inputPath }
    }
  }
`);

const resolveAppealMutation = parse(`
  mutation Resolve(
    $appealId: ID!
    $result: FlagAppealResult!
    $rationale: String!
    $replacement: ReplacementActionInput
  ) {
    resolveFlagAppeal(
      appealId: $appealId
      result: $result
      reviewRationale: $rationale
      replacement: $replacement
    ) {
      __typename
      ... on FlagAppeal { uuid status result reviewRationale }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
      ... on InvalidInputError { inputPath }
    }
  }
`);

const loginMutation = parse(`
  mutation Login($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) { id }
  }
`);

const postQuery = parse(`
  query PostContent($id: ID!) {
    node(id: $id) {
      ... on Note {
        censored
        content
        excerpt
        hashtags { name }
        media { url }
        link { url }
        mentions(first: 5) { edges { node { handle } } }
        sharedPost { id }
        quotedPost { id }
      }
    }
  }
`);

test("Account.sanctions shows the sanitized surface to the target only", async () => {
  await withRollback(async (tx) => {
    const { reported, action, post } = await sanction(tx);
    const own = await execute({
      schema,
      document: sanctionsQuery,
      variableValues: { username: "reported" },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(own.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const sanctions = (own.data as any)?.accountByUsername?.sanctions;
    assert.equal(sanctions?.length, 1);
    assert.equal(sanctions[0].uuid, action.id);
    assert.equal(sanctions[0].actionType, "WARNING");
    assert.deepEqual(sanctions[0].violatedProvisions, ["2.3"]);
    assert.equal(
      sanctions[0].messageToUser,
      "Please review our code of conduct.",
    );
    assert.equal(sanctions[0].targetPostIri, post.iri);
    assert.equal(sanctions[0].appeal, null);
    assert.ok(sanctions[0].appealableUntil != null);
    // The sanitized surface never carries the internal rationale, the
    // moderator, the reporter, or the report count:
    const raw = JSON.stringify(own.data);
    assert.ok(!raw.includes("Internal moderator-only rationale."));
    assert.ok(!raw.includes(REASON));
    assert.ok(!raw.includes("reporter"));
    assert.ok(!raw.includes("mod@example.com"));

    // A third party gets nothing:
    const other = await insertAccountWithActor(tx, {
      username: "other",
      name: "Other",
      email: "other@example.com",
    });
    const foreign = await execute({
      schema,
      document: sanctionsQuery,
      variableValues: { username: "reported" },
      contextValue: makeUserContext(tx, other.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (foreign.data as any)?.accountByUsername?.sanctions ?? null,
      null,
    );
  });
});

test("appealModerationAction files an appeal for the target only", async () => {
  await withRollback(async (tx) => {
    const { reported, action } = await sanction(tx);
    const result = await execute({
      schema,
      document: appealMutation,
      variableValues: {
        sanctionId: action.id,
        reason: "I believe this decision misread the context.",
        context: "The thread was satirical.",
      },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const appeal = (result.data as any)?.appealModerationAction;
    assert.equal(appeal?.__typename, "FlagAppeal");
    assert.equal(appeal?.status, "PENDING");
    assert.equal(appeal?.result, null);

    // One appeal per action:
    const dup = await execute({
      schema,
      document: appealMutation,
      variableValues: { sanctionId: action.id, reason: "Again, please." },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (dup.data as any)?.appealModerationAction?.__typename,
      "InvalidInputError",
    );

    // Only the sanctioned user can appeal:
    const other = await insertAccountWithActor(tx, {
      username: "other",
      name: "Other",
      email: "other@example.com",
    });
    const foreign = await execute({
      schema,
      document: appealMutation,
      variableValues: {
        sanctionId: action.id,
        reason: "Objecting on someone else's behalf.",
      },
      contextValue: makeUserContext(tx, other.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (foreign.data as any)?.appealModerationAction?.inputPath,
      "sanctionId",
    );
  });
});

test("resolveFlagAppeal reviews appeals (moderators only)", async () => {
  await withRollback(async (tx) => {
    const { moderator, reported, action, post } = await sanction(
      tx,
      "censor",
    );
    const censoredPost = await tx.query.postTable.findFirst({
      where: { id: post.id },
    });
    assert.ok(censoredPost?.censored != null);
    const filed = await execute({
      schema,
      document: appealMutation,
      variableValues: {
        sanctionId: action.id,
        reason: "The post did not violate anything.",
      },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const appealGid = (filed.data as any)?.appealModerationAction?.id;
    assert.ok(appealGid != null);

    // Non-moderators cannot review:
    const denied = await execute({
      schema,
      document: resolveAppealMutation,
      variableValues: {
        appealId: appealGid,
        result: "WITHDRAWN",
        rationale: "Nope.",
      },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (denied.data as any)?.resolveFlagAppeal?.__typename,
      "NotAuthorizedError",
    );

    // Replacement is required for REDUCED:
    const missing = await execute({
      schema,
      document: resolveAppealMutation,
      variableValues: {
        appealId: appealGid,
        result: "REDUCED",
        rationale: "Missing replacement.",
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (missing.data as any)?.resolveFlagAppeal?.inputPath,
      "replacement",
    );

    // Withdrawing reverts the censorship:
    const resolved = await execute({
      schema,
      document: resolveAppealMutation,
      variableValues: {
        appealId: appealGid,
        result: "WITHDRAWN",
        rationale: "On review, no violation.",
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(resolved.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const appeal = (resolved.data as any)?.resolveFlagAppeal;
    assert.equal(appeal?.__typename, "FlagAppeal");
    assert.equal(appeal?.status, "RESOLVED");
    assert.equal(appeal?.result, "WITHDRAWN");
    const restoredPost = await tx.query.postTable.findFirst({
      where: { id: post.id },
    });
    assert.equal(restoredPost?.censored, null);
  });
});

test("completeLoginChallenge rejects banned accounts", async () => {
  await withRollback(async (tx) => {
    const { reported } = await sanction(tx, "ban");
    const kv = createTestKv();
    const token = await createSigninToken(kv.kv, reported.account.id);
    const result = await execute({
      schema,
      document: loginMutation,
      variableValues: { token: token.token, code: token.code },
      contextValue: makeUserContext(tx, reported.account, { kv: kv.kv }),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((result.data as any)?.completeLoginChallenge ?? null, null);

    // An unsanctioned account still logs in:
    const fine = await insertAccountWithActor(tx, {
      username: "fine",
      name: "Fine",
      email: "fine@example.com",
    });
    const token2 = await createSigninToken(kv.kv, fine.account.id);
    const ok = await execute({
      schema,
      document: loginMutation,
      variableValues: { token: token2.token, code: token2.code },
      contextValue: makeUserContext(tx, fine.account, { kv: kv.kv }),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.ok((ok.data as any)?.completeLoginChallenge?.id != null);
  });
});

test("censored posts expose the flag and redact content", async () => {
  await withRollback(async (tx) => {
    const { reported, post } = await sanction(tx, "censor");
    const gid = encodeGlobalID("Note", post.id);
    const guestLike = await insertAccountWithActor(tx, {
      username: "viewer",
      name: "Viewer",
      email: "viewer@example.com",
    });

    const viewerResult = await execute({
      schema,
      document: postQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, guestLike.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const viewerNode = (viewerResult.data as any)?.node;
    assert.ok(viewerNode?.censored != null);
    assert.equal(viewerNode?.content, "");
    assert.equal(viewerNode?.excerpt, "");
    assert.deepEqual(viewerNode?.hashtags, []);
    assert.deepEqual(viewerNode?.media, []);
    assert.equal(viewerNode?.link, null);
    assert.deepEqual(viewerNode?.mentions?.edges, []);
    assert.equal(viewerNode?.sharedPost, null);
    assert.equal(viewerNode?.quotedPost, null);

    // The author keeps access to their own censored content:
    const authorResult = await execute({
      schema,
      document: postQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const authorNode = (authorResult.data as any)?.node;
    assert.ok(authorNode?.censored != null);
    assert.match(authorNode?.content ?? "", /Hello world/);
  });
});

test("moderators file appeals on behalf of banned users", async () => {
  await withRollback(async (tx) => {
    const { moderator, reported, action } = await sanction(tx, "ban");
    const onBehalfMutation = parse(`
      mutation AppealOnBehalf(
        $sanctionId: UUID!
        $reason: String!
        $onBehalfOf: ID!
      ) {
        appealModerationAction(
          sanctionId: $sanctionId
          reason: $reason
          onBehalfOf: $onBehalfOf
        ) {
          __typename
          ... on FlagAppeal { uuid status }
          ... on NotAuthorizedError { notAuthorized }
          ... on InvalidInputError { inputPath }
        }
      }
    `);
    const accountGid = encodeGlobalID("Account", reported.account.id);
    // Non-moderators cannot use onBehalfOf:
    const other = await insertAccountWithActor(tx, {
      username: "other",
      name: "Other",
      email: "other@example.com",
    });
    const denied = await execute({
      schema,
      document: onBehalfMutation,
      variableValues: {
        sanctionId: action.id,
        reason: "Filed sneakily.",
        onBehalfOf: accountGid,
      },
      contextValue: makeUserContext(tx, other.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (denied.data as any)?.appealModerationAction?.__typename,
      "NotAuthorizedError",
    );
    // A moderator files the email-received appeal on the user's behalf:
    const filed = await execute({
      schema,
      document: onBehalfMutation,
      variableValues: {
        sanctionId: action.id,
        reason: "Appeal received by email from the banned user.",
        onBehalfOf: accountGid,
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const appeal = (filed.data as any)?.appealModerationAction;
    assert.equal(appeal?.__typename, "FlagAppeal");
    assert.equal(appeal?.status, "PENDING");
  });
});

test("ban emails direct appeals to email replies", async () => {
  await withRollback(async (tx) => {
    const { action } = await sanction(tx, "ban");
    const message = await getModerationActionEmail({
      locale: new Intl.Locale("en"),
      to: "reported@example.com",
      action,
      targetUrl: null,
      appealUrl: "http://localhost/@reported/settings/sanctions",
    });
    const body = message.content.text ?? "";
    assert.match(body, /replying to this email/);
    // No in-app appeal URL, which a banned account cannot reach:
    assert.ok(!body.includes("/settings/sanctions"));
  });
});

test("censored articles redact their content versions", async () => {
  await withRollback(async (tx) => {
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
    const article = await createArticle(fedCtx, {
      accountId: reported.account.id,
      slug: "offensive-article",
      title: "Offensive article",
      content: "Original article markdown",
      language: "en",
      tags: [],
      allowLlmTranslation: false,
    });
    assert.ok(article != null);
    const flag = await createFlag(tx, {
      reporter: reporter.actor,
      targetActor: reported.actor,
      targetPost: article,
      reason: REASON,
    });
    assert.ok(flag != null);
    const action = await takeModerationAction(fedCtx, {
      caseId: flag.caseId,
      moderator,
      actionType: "censor",
      violatedProvisions: ["2.3"],
      rationale: "Censored.",
    });
    assert.ok(action != null);
    const articleQuery = parse(`
      query CensoredArticle($id: ID!) {
        node(id: $id) {
          ... on Article {
            censored
            name
            summary
            contents { title rawContent content }
          }
        }
      }
    `);
    const gid = encodeGlobalID("Article", article.id);
    const viewer = await insertAccountWithActor(tx, {
      username: "viewer",
      name: "Viewer",
      email: "viewer@example.com",
    });
    const viewerResult = await execute({
      schema,
      document: articleQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const viewerNode = (viewerResult.data as any)?.node;
    assert.ok(viewerNode?.censored != null);
    assert.deepEqual(viewerNode?.contents, []);
    assert.equal(viewerNode?.name, null);
    assert.equal(viewerNode?.summary, null);
    const raw = JSON.stringify(viewerResult.data);
    assert.ok(!raw.includes("Original article markdown"));
    assert.ok(!raw.includes("Offensive article"));

    // The author keeps access:
    const authorResult = await execute({
      schema,
      document: articleQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const authorNode = (authorResult.data as any)?.node;
    assert.equal(authorNode?.contents?.length, 1);
    assert.equal(
      authorNode?.contents[0]?.rawContent,
      "Original article markdown",
    );
  });
});

test("censored questions hide their polls, even via node lookups", async () => {
  await withRollback(async (tx) => {
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
    const question = await createQuestion(
      fedCtx as unknown as Parameters<typeof createQuestion>[0],
      {
        accountId: reported.account.id,
        visibility: "public",
        content: "Which option is offensive?",
        language: "en",
        media: [],
        poll: {
          multiple: false,
          title: "Which option is offensive?",
          options: ["Secret option A", "Secret option B"],
          ends: new Date(Date.now() + 24 * HOUR),
        },
      },
    );
    assert.ok(question != null);
    const flag = await createFlag(tx, {
      reporter: reporter.actor,
      targetActor: reported.actor,
      targetPost: question,
      reason: REASON,
    });
    assert.ok(flag != null);
    const action = await takeModerationAction(fedCtx, {
      caseId: flag.caseId,
      moderator,
      actionType: "censor",
      violatedProvisions: ["2.3"],
      rationale: "Censored.",
    });
    assert.ok(action != null);
    // Direct Poll node lookups are additionally guarded by the type-level
    // scope (defense in depth; the drizzle loader currently cannot load
    // Poll nodes by id at all, but the scope keeps the redaction intact
    // if that ever changes):
    const pollNodeQuery = parse(`
      query CensoredPoll($id: ID!) {
        node(id: $id) {
          __typename
          ... on Poll { options { title } }
        }
      }
    `);
    const pollGid = encodeGlobalID("Poll", question.id);
    const viewer = await insertAccountWithActor(tx, {
      username: "viewer",
      name: "Viewer",
      email: "viewer@example.com",
    });
    const viewerNodeResult = await execute({
      schema,
      document: pollNodeQuery,
      variableValues: { id: pollGid },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((viewerNodeResult.data as any)?.node ?? null, null);
    assert.ok(
      !JSON.stringify(viewerNodeResult.data).includes("Secret option"),
    );
    // The Question.poll path: redacted for the viewer, intact for the
    // author.
    const questionPollQuery = parse(`
      query CensoredQuestion($id: ID!) {
        node(id: $id) {
          ... on Question {
            poll { options { title } }
          }
        }
      }
    `);
    const questionGid = encodeGlobalID("Question", question.id);
    const viewerResult = await execute({
      schema,
      document: questionPollQuery,
      variableValues: { id: questionGid },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((viewerResult.data as any)?.node?.poll ?? null, null);
    assert.ok(
      !JSON.stringify(viewerResult.data).includes("Secret option"),
    );
    const authorResult = await execute({
      schema,
      document: questionPollQuery,
      variableValues: { id: questionGid },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (authorResult.data as any)?.node?.poll?.options?.length,
      2,
    );
  });
});

test("suspended actors are flagged on the Actor type", async () => {
  await withRollback(async (tx) => {
    const { reported } = await sanction(tx, "suspend");
    const actorQuery = parse(`
      query SuspendedActor($handle: String!) {
        actorByHandle(handle: $handle) { suspended }
      }
    `);
    const viewer = await insertAccountWithActor(tx, {
      username: "viewer",
      name: "Viewer",
      email: "viewer@example.com",
    });
    const result = await execute({
      schema,
      document: actorQuery,
      variableValues: { handle: reported.actor.handle },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((result.data as any)?.actorByHandle?.suspended, true);
    // Lift the suspension; the flag turns off lazily:
    await tx.update(actorTable)
      .set({ suspended: null, suspendedUntil: null })
      .where(eq(actorTable.id, reported.actor.id));
    const lifted = await execute({
      schema,
      document: actorQuery,
      variableValues: { handle: reported.actor.handle },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((lifted.data as any)?.actorByHandle?.suspended, false);
  });
});
