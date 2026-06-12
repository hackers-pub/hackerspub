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
  postTable,
} from "@hackerspub/models/schema";
import { createSigninToken } from "@hackerspub/models/signin";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { getModerationActionEmail } from "./moderation-email.ts";
import type { Message } from "@upyo/core";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  type AuthenticatedAccount,
  createFedCtx,
  createTestEmailTransport,
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

const appealsQuery = parse(`
  query Appeals($status: FlagAppealStatus) {
    moderationAppeals(first: 10, status: $status) {
      edges { node { uuid status reason } }
    }
  }
`);

const loginMutation = parse(`
  mutation Login($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) {
      __typename
      ... on Session {
        id
      }
      ... on AccountBannedError {
        since
      }
    }
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

test("moderationAppeals lists appeals for moderators only", async () => {
  await withRollback(async (tx) => {
    const { moderator, reported, action } = await sanction(tx);
    const filed = await execute({
      schema,
      document: appealMutation,
      variableValues: {
        sanctionId: action.id,
        reason: "I did nothing wrong.",
      },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (filed.data as any)?.appealModerationAction?.__typename,
      "FlagAppeal",
    );

    // Moderators see the appeal in the queue:
    const asMod = await execute({
      schema,
      document: appealsQuery,
      variableValues: { status: "PENDING" },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const edges = (asMod.data as any)?.moderationAppeals?.edges;
    assert.equal(edges?.length, 1);
    assert.equal(edges[0].node.reason, "I did nothing wrong.");
    assert.equal(edges[0].node.status, "PENDING");

    // Non-moderators get null, never another user's appeals:
    const asUser = await execute({
      schema,
      document: appealsQuery,
      variableValues: {},
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (asUser.data as any)?.moderationAppeals,
      null,
    );
  });
});

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
    const banned = (result.data as any)?.completeLoginChallenge;
    assert.equal(banned?.__typename, "AccountBannedError");
    assert.equal(banned?.id ?? null, null);

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

test("share wrappers of censored posts are redacted too", async () => {
  await withRollback(async (tx) => {
    const { reported, post } = await sanction(tx, "censor");
    const sharer = await insertAccountWithActor(tx, {
      username: "sharer",
      name: "Sharer",
      email: "sharer@example.com",
    });
    // Share wrappers denormalize the boosted post's title/content/URL
    // (see sharePost in models/post.ts), so the wrapper row carries the
    // censored content verbatim.
    const wrapperId = generateUuidV7();
    await tx.insert(postTable).values({
      id: wrapperId,
      iri: `http://localhost/ap/announces/${wrapperId}`,
      type: post.type,
      visibility: "public",
      actorId: sharer.actor.id,
      sharedPostId: post.id,
      name: post.name,
      contentHtml: post.contentHtml,
      language: post.language,
      tags: {},
      emojis: post.emojis,
      sensitive: post.sensitive,
      url: post.url,
    });
    const wrapperQuery = parse(`
      query Wrapper($id: ID!) {
        node(id: $id) {
          ... on Note {
            name
            content
            excerpt
            url
            sharedPost { content }
          }
        }
      }
    `);
    const gid = encodeGlobalID("Note", wrapperId);
    const viewer = await insertAccountWithActor(tx, {
      username: "wrapperviewer",
      name: "Wrapper Viewer",
      email: "wrapperviewer@example.com",
    });

    const viewerResult = await execute({
      schema,
      document: wrapperQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const viewerNode = (viewerResult.data as any)?.node;
    assert.ok(viewerNode != null);
    assert.equal(viewerNode.name, null);
    assert.equal(viewerNode.content, "");
    assert.equal(viewerNode.excerpt, "");
    assert.equal(viewerNode.url, null);
    assert.equal(viewerNode.sharedPost?.content, "");

    // The boosted post's author still sees the copied content:
    const authorResult = await execute({
      schema,
      document: wrapperQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const authorNode = (authorResult.data as any)?.node;
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
      tags: ["secret-tag"],
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
            tags
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
    assert.deepEqual(viewerNode?.tags, []);
    const raw = JSON.stringify(viewerResult.data);
    assert.ok(!raw.includes("Original article markdown"));
    assert.ok(!raw.includes("Offensive article"));
    assert.ok(!raw.includes("secret-tag"));

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
    assert.deepEqual(authorNode?.tags, ["secret-tag"]);
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

test("a still-banned appellant gets the appeal outcome by email", async () => {
  await withRollback(async (tx) => {
    const { moderator, reported, action } = await sanction(tx, "ban");
    const onBehalfMutation = parse(`
      mutation AppealOnBehalfForEmail(
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
          ... on FlagAppeal { uuid }
        }
      }
    `);
    const filed = await execute({
      schema,
      document: onBehalfMutation,
      variableValues: {
        sanctionId: action.id,
        reason: "Filed by email on the banned user's behalf.",
        onBehalfOf: encodeGlobalID("Account", reported.account.id),
      },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const appealUuid = (filed.data as any)?.appealModerationAction?.uuid;
    assert.ok(appealUuid != null);

    // A different moderator denies the appeal; the appellant remains
    // banned, so the outcome must go out by email.
    const reviewer = await makeModerator(tx, {
      username: "reviewer",
      name: "Reviewer",
      email: "reviewer@example.com",
    });
    const email = createTestEmailTransport();
    const resolved = await execute({
      schema,
      document: resolveAppealMutation,
      variableValues: {
        appealId: encodeGlobalID("FlagAppeal", appealUuid),
        result: "DISMISSED",
        rationale: "The permanent suspension stands.",
      },
      contextValue: makeUserContext(tx, reviewer, { email: email.transport }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (resolved.data as any)?.resolveFlagAppeal?.__typename,
      "FlagAppeal",
    );
    assert.equal(email.messages.length, 1);
    const message = email.messages[0] as Message;
    assert.deepEqual(
      message.recipients.map((r) => r.address),
      ["reported@example.com"],
    );
    const body = message.content.text ?? "";
    assert.match(body, /The permanent suspension stands\./);
    assert.match(body, /Appeal denied/);
  });
});

test("censored posts cannot be boosted", async () => {
  await withRollback(async (tx) => {
    const { post } = await sanction(tx, "censor");
    const booster = await insertAccountWithActor(tx, {
      username: "booster",
      name: "Booster",
      email: "booster@example.com",
    });
    const shareMutation = parse(`
      mutation ShareCensored($postId: ID!) {
        sharePost(input: { postId: $postId }) {
          __typename
          ... on InvalidInputError { inputPath }
        }
      }
    `);
    const result = await execute({
      schema,
      document: shareMutation,
      variableValues: { postId: encodeGlobalID("Note", post.id) },
      contextValue: makeUserContext(tx, booster.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const data = (result.data as any)?.sharePost;
    assert.equal(data?.__typename, "InvalidInputError");
    assert.equal(data?.inputPath, "postId");
  });
});

test("share wrappers of censored questions are redacted too", async () => {
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
    // The wrapper denormalizes the Question's content and URL, and the
    // Question variant has its own content/url field overrides, so the
    // wrapper-aware redaction must cover them too.
    const sharer = await insertAccountWithActor(tx, {
      username: "sharer",
      name: "Sharer",
      email: "sharer@example.com",
    });
    const wrapperId = generateUuidV7();
    await tx.insert(postTable).values({
      id: wrapperId,
      iri: `http://localhost/ap/announces/${wrapperId}`,
      type: question.type,
      visibility: "public",
      actorId: sharer.actor.id,
      sharedPostId: question.id,
      name: question.name,
      contentHtml: question.contentHtml,
      language: question.language,
      tags: {},
      emojis: question.emojis,
      sensitive: question.sensitive,
      url: question.url,
    });
    const wrapperQuery = parse(`
      query WrapperQuestion($id: ID!) {
        node(id: $id) {
          ... on Question {
            content
            url
            sharedPost {
              ... on Question {
                content
                poll { options { title } }
              }
            }
          }
        }
      }
    `);
    const gid = encodeGlobalID("Question", wrapperId);
    const viewer = await insertAccountWithActor(tx, {
      username: "viewer",
      name: "Viewer",
      email: "viewer@example.com",
    });
    const viewerResult = await execute({
      schema,
      document: wrapperQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const viewerNode = (viewerResult.data as any)?.node;
    assert.ok(viewerNode != null);
    assert.equal(viewerNode.content, "");
    assert.equal(viewerNode.url, null);
    assert.equal(viewerNode.sharedPost?.content, "");
    assert.equal(viewerNode.sharedPost?.poll ?? null, null);
    assert.ok(!JSON.stringify(viewerResult.data).includes("offensive"));
    assert.ok(!JSON.stringify(viewerResult.data).includes("Secret option"));

    // The boosted Question's author still sees the copied content:
    const authorResult = await execute({
      schema,
      document: wrapperQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, reported.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const authorNode = (authorResult.data as any)?.node;
    assert.match(authorNode?.content ?? "", /offensive/);
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
