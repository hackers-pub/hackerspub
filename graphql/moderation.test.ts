import assert from "node:assert";
import test from "node:test";
import type { Transaction } from "@hackerspub/models/db";
import { accountTable, postTable } from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  type AuthenticatedAccount,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  makeGuestContext,
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

const reportContentMutation = parse(`
  mutation ReportContent(
    $targetId: ID!
    $reason: String!
    $forwardToRemote: Boolean
  ) {
    reportContent(
      targetId: $targetId
      reason: $reason
      forwardToRemote: $forwardToRemote
    ) {
      __typename
      ... on Flag {
        id
        uuid
        reason
        status
        forwardToRemote
        targetPostIri
        targetActor { handle }
      }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on InvalidInputError { inputPath }
      ... on DuplicateReportError { duplicateReport }
    }
  }
`);

const flagNodeQuery = parse(`
  query FlagNode($id: ID!) {
    node(id: $id) {
      __typename
      ... on Flag {
        uuid
        reason
      }
    }
  }
`);

const flagReporterQuery = parse(`
  query FlagReporter($id: ID!) {
    node(id: $id) {
      __typename
      ... on Flag {
        uuid
        reporter { handle }
      }
    }
  }
`);

const reportsQuery = parse(`
  query Reports($username: String!) {
    accountByUsername(username: $username) {
      reports(first: 10) {
        totalCount
        edges {
          node {
            uuid
            reason
            status
          }
        }
      }
    }
  }
`);

test("reportContent rejects guests and invalid input", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "author",
      name: "Author",
      email: "author@example.com",
    });
    const { post } = await insertNotePost(tx, { account: author.account });
    const targetId = encodeGlobalID("Note", post.id);

    const guestResult = await execute({
      schema,
      document: reportContentMutation,
      variableValues: { targetId, reason: REASON },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (guestResult.data as any)?.reportContent?.__typename,
      "NotAuthenticatedError",
    );

    const reporter = await insertAccountWithActor(tx, {
      username: "reporter",
      name: "Reporter",
      email: "reporter@example.com",
    });
    const shortResult = await execute({
      schema,
      document: reportContentMutation,
      variableValues: { targetId, reason: "spam" },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const short = (shortResult.data as any)?.reportContent;
    assert.equal(short?.__typename, "InvalidInputError");
    assert.equal(short?.inputPath, "reason");

    // Reporting your own post is rejected:
    const selfResult = await execute({
      schema,
      document: reportContentMutation,
      variableValues: { targetId, reason: REASON },
      contextValue: makeUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const self = (selfResult.data as any)?.reportContent;
    assert.equal(self?.__typename, "InvalidInputError");
    assert.equal(self?.inputPath, "targetId");
  });
});

test("reportContent files a post report and deduplicates", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "author",
      name: "Author",
      email: "author@example.com",
    });
    const reporter = await insertAccountWithActor(tx, {
      username: "reporter",
      name: "Reporter",
      email: "reporter@example.com",
    });
    const { post } = await insertNotePost(tx, { account: author.account });
    const targetId = encodeGlobalID("Note", post.id);

    const result = await execute({
      schema,
      document: reportContentMutation,
      variableValues: { targetId, reason: REASON },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const flag = (result.data as any)?.reportContent;
    assert.equal(flag?.__typename, "Flag");
    assert.equal(flag?.reason, REASON);
    assert.equal(flag?.status, "PENDING");
    assert.equal(flag?.forwardToRemote, false);
    assert.equal(flag?.targetPostIri, post.iri);
    assert.equal(flag?.targetActor?.handle, author.actor.handle);
    const stored = await tx.query.flagTable.findFirst({
      where: { id: flag.uuid },
    });
    assert.ok(stored != null);
    assert.equal(stored.reporterId, reporter.actor.id);

    // The same reporter cannot file a second open report on the target:
    const dup = await execute({
      schema,
      document: reportContentMutation,
      variableValues: {
        targetId,
        reason: "Reporting this a second time.",
      },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (dup.data as any)?.reportContent?.__typename,
      "DuplicateReportError",
    );
  });
});

test("reportContent files a report on a boost wrapper", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "boostreportauthor",
      name: "Boost Report Author",
      email: "boostreportauthor@example.com",
    });
    const { post: original } = await insertNotePost(tx, {
      account: author.account,
    });
    const booster = await insertAccountWithActor(tx, {
      username: "boostreportbooster",
      name: "Boost Report Booster",
      email: "boostreportbooster@example.com",
    });
    // A boost wrapper of the (non-sanctioned) original, denormalizing its
    // content; the report target is the wrapper id, as shown in a timeline.
    const wrapperId = generateUuidV7();
    await tx.insert(postTable).values({
      id: wrapperId,
      iri: `http://localhost/ap/announces/${wrapperId}`,
      type: "Note",
      visibility: "public",
      actorId: booster.actor.id,
      sharedPostId: original.id,
      contentHtml: "<p>Boosted note</p>",
      language: "en",
      tags: {},
      emojis: {},
      sensitive: false,
      url: original.url,
    });
    const reporter = await insertAccountWithActor(tx, {
      username: "boostreportreporter",
      name: "Boost Report Reporter",
      email: "boostreportreporter@example.com",
    });

    // Reporting the boost wrapper must succeed: the boosted author is not
    // sanctioned, so the wrapper is visible once sharedPost is hydrated (it
    // previously failed closed with InvalidInputError on the unloaded
    // wrapper).
    const result = await execute({
      schema,
      document: reportContentMutation,
      variableValues: {
        targetId: encodeGlobalID("Note", wrapperId),
        reason: REASON,
      },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const flag = (result.data as any)?.reportContent;
    assert.equal(flag?.__typename, "Flag");
    assert.equal(flag?.targetActor?.handle, booster.actor.handle);
  });
});

test("reportContent files a user report with forwarding opt-in", async () => {
  await withRollback(async (tx) => {
    const reporter = await insertAccountWithActor(tx, {
      username: "reporter",
      name: "Reporter",
      email: "reporter@example.com",
    });
    const remote = await insertRemoteActor(tx, {
      username: "troll",
      name: "Troll",
      host: "remote.example",
    });
    const targetId = encodeGlobalID("Actor", remote.id);
    const result = await execute({
      schema,
      document: reportContentMutation,
      variableValues: {
        targetId,
        reason: "This user's profile is full of hate speech.",
        forwardToRemote: true,
      },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const flag = (result.data as any)?.reportContent;
    assert.equal(flag?.__typename, "Flag");
    assert.equal(flag?.forwardToRemote, true);
    assert.equal(flag?.targetPostIri, null);
  });
});

test("Flag nodes are visible to their reporter and moderators only", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "author",
      name: "Author",
      email: "author@example.com",
    });
    const reporter = await insertAccountWithActor(tx, {
      username: "reporter",
      name: "Reporter",
      email: "reporter@example.com",
    });
    const moderator = await makeModerator(tx, {
      username: "mod",
      name: "Mod",
      email: "mod@example.com",
    });
    const { post } = await insertNotePost(tx, { account: author.account });
    const targetId = encodeGlobalID("Note", post.id);
    const created = await execute({
      schema,
      document: reportContentMutation,
      variableValues: { targetId, reason: REASON },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const gid = (created.data as any)?.reportContent?.id;
    assert.ok(gid != null);

    // The reporter can read their own report:
    const own = await execute({
      schema,
      document: flagNodeQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((own.data as any)?.node?.__typename, "Flag");

    // A moderator can read it too:
    const mod = await execute({
      schema,
      document: flagNodeQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((mod.data as any)?.node?.__typename, "Flag");

    // The reported user (or any third party) cannot even confirm it exists:
    const target = await execute({
      schema,
      document: flagNodeQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((target.data as any)?.node ?? null, null);

    const guest = await execute({
      schema,
      document: flagNodeQuery,
      variableValues: { id: gid },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    assert.equal((guest.data as any)?.node ?? null, null);
  });
});

test("Flag.reporter is resolvable by moderators only", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "author",
      name: "Author",
      email: "author@example.com",
    });
    const reporter = await insertAccountWithActor(tx, {
      username: "reporter",
      name: "Reporter",
      email: "reporter@example.com",
    });
    const moderator = await makeModerator(tx, {
      username: "mod",
      name: "Mod",
      email: "mod@example.com",
    });
    const { post } = await insertNotePost(tx, { account: author.account });
    const created = await execute({
      schema,
      document: reportContentMutation,
      variableValues: {
        targetId: encodeGlobalID("Note", post.id),
        reason: REASON,
      },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const gid = (created.data as any)?.reportContent?.id;

    // A moderator sees the reporter:
    const mod = await execute({
      schema,
      document: flagReporterQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (mod.data as any)?.node?.reporter?.handle,
      reporter.actor.handle,
    );

    // The reporter themselves cannot resolve the moderator-only field;
    // whatever shape the denial takes, the handle must not leak:
    const own = await execute({
      schema,
      document: flagReporterQuery,
      variableValues: { id: gid },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    assert.notEqual(
      // deno-lint-ignore no-explicit-any
      (own.data as any)?.node?.reporter?.handle ?? null,
      reporter.actor.handle,
    );
  });
});

test("Account.reports lists only the account's own reports", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "author",
      name: "Author",
      email: "author@example.com",
    });
    const reporter = await insertAccountWithActor(tx, {
      username: "reporter",
      name: "Reporter",
      email: "reporter@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "other",
      name: "Other",
      email: "other@example.com",
    });
    const { post } = await insertNotePost(tx, { account: author.account });
    await execute({
      schema,
      document: reportContentMutation,
      variableValues: {
        targetId: encodeGlobalID("Note", post.id),
        reason: REASON,
      },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });

    const own = await execute({
      schema,
      document: reportsQuery,
      variableValues: { username: "reporter" },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(own.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const connection = (own.data as any)?.accountByUsername?.reports;
    assert.equal(connection?.totalCount, 1);
    assert.equal(connection?.edges?.length, 1);
    assert.equal(connection?.edges[0]?.node?.reason, REASON);
    assert.equal(connection?.edges[0]?.node?.status, "PENDING");

    // Another signed-in user cannot read someone else's report history:
    const foreign = await execute({
      schema,
      document: reportsQuery,
      variableValues: { username: "reporter" },
      contextValue: makeUserContext(tx, other.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      // deno-lint-ignore no-explicit-any
      (foreign.data as any)?.accountByUsername?.reports ?? null,
      null,
    );
  });
});

test("Account.reports hides reports targeting the viewing moderator", async () => {
  await withRollback(async (tx) => {
    const moderator = await makeModerator(tx, {
      username: "selfmod",
      name: "Self Mod",
      email: "selfmod@example.com",
    });
    const reporter = await insertAccountWithActor(tx, {
      username: "reporter",
      name: "Reporter",
      email: "reporter@example.com",
    });
    const victim = await insertAccountWithActor(tx, {
      username: "victim",
      name: "Victim",
      email: "victim@example.com",
    });
    // The reporter files one report against the moderator's own post and one
    // against an unrelated victim's post.
    const modPost = (await insertNotePost(tx, { account: moderator })).post;
    const victimPost = (await insertNotePost(tx, { account: victim.account }))
      .post;
    for (const post of [modPost, victimPost]) {
      await execute({
        schema,
        document: reportContentMutation,
        variableValues: {
          targetId: encodeGlobalID("Note", post.id),
          reason: REASON,
        },
        contextValue: makeUserContext(tx, reporter.account),
        onError: "NO_PROPAGATE",
      });
    }

    // A moderator may review the reporter's history, but the report against
    // the moderator themselves must not surface (neither edges nor count),
    // or it would reveal that this reporter reported them.
    const asMod = await execute({
      schema,
      document: reportsQuery,
      variableValues: { username: "reporter" },
      contextValue: makeUserContext(tx, moderator),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(asMod.errors, undefined);
    // deno-lint-ignore no-explicit-any
    const modView = (asMod.data as any)?.accountByUsername?.reports;
    assert.equal(modView?.totalCount, 1);
    assert.equal(modView?.edges?.length, 1);

    // The reporter still sees their own full history, including the report
    // they filed against the moderator.
    const asSelf = await execute({
      schema,
      document: reportsQuery,
      variableValues: { username: "reporter" },
      contextValue: makeUserContext(tx, reporter.account),
      onError: "NO_PROPAGATE",
    });
    // deno-lint-ignore no-explicit-any
    const selfView = (asSelf.data as any)?.accountByUsername?.reports;
    assert.equal(selfView?.totalCount, 2);
    assert.equal(selfView?.edges?.length, 2);
  });
});
