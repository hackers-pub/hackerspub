import assert from "node:assert";
import test from "node:test";
import {
  Note as ActivityPubNote,
  Question as ActivityPubQuestion,
  QuoteRequest,
} from "@fedify/vocab";
import { eq } from "drizzle-orm";
import type { ApplicationContext } from "./context.ts";
import type { Transaction } from "./db.ts";
import {
  findQuoteAuthorizationRerequestPostIds,
  rerequestQuoteAuthorization,
} from "./post/quote-rerequest.ts";
import {
  actorTable,
  blockingTable,
  pollOptionTable,
  pollTable,
  postTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

test("rerequestQuoteAuthorization() requests approval for a legacy remote quote", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "legacyquoteauthor",
      name: "Legacy Quote Author",
      email: "legacyquoteauthor@example.com",
    });
    const remoteActor = await insertRemoteActor(tx, {
      username: "legacyquotetarget",
      name: "Legacy Quote Target",
      host: "remote.example",
    });
    const target = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Legacy quote target</p>",
    });
    const { noteSourceId, post: quote } = await insertNotePost(tx, {
      account: author.account,
      content: "Legacy quote without an authorization",
      quotedPostId: target.id,
    });
    quote.iri = `http://localhost/objects/${noteSourceId}`;
    target.quotesCount = 1;
    await tx
      .update(postTable)
      .set({ iri: quote.iri })
      .where(eq(postTable.id, quote.id));
    await tx
      .update(postTable)
      .set({ quotesCount: target.quotesCount })
      .where(eq(postTable.id, target.id));
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as ApplicationContext<Transaction>;

    assert.deepEqual(
      await findQuoteAuthorizationRerequestPostIds(tx, noteSourceId),
      [quote.id],
    );
    const result = await rerequestQuoteAuthorization(fedCtx, quote.id);

    assert.ok(result.status === "requested");
    assert.equal(result.postId, quote.id);
    assert.equal(result.noteSourceId, noteSourceId);
    const updated = await tx.query.postTable.findFirst({
      where: { id: quote.id },
    });
    assert.equal(updated?.quotedPostId, target.id);
    assert.equal(updated?.quoteAuthorizationIri, null);
    assert.equal(updated?.quoteTargetState, "pending");
    const storedRequest = await tx.query.quoteRequestTable.findFirst({
      where: { quotePostId: quote.id },
    });
    assert.equal(storedRequest?.quotedPostId, target.id);
    assert.equal(storedRequest?.iri, result.requestIri);
    const request = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof QuoteRequest);
    assert.ok(request instanceof QuoteRequest);
    assert.equal(request.objectId?.href, target.iri);
    assert.equal(
      request.actorId?.href,
      `http://localhost/actors/${author.account.id}`,
    );
    const instrument = await request.getInstrument({
      ...fedCtx,
      suppressError: true,
    });
    assert.ok(instrument instanceof ActivityPubNote);
    assert.equal(instrument.id?.href, quote.iri);
    assert.equal(instrument.quoteId?.href, target.iri);
    const recipient = sent[0][1] as { id: URL; inboxId: URL };
    assert.equal(recipient.id.href, remoteActor.iri);
    assert.equal(recipient.inboxId.href, remoteActor.inboxUrl);

    const repeated = await rerequestQuoteAuthorization(fedCtx, quote.id);
    assert.deepEqual(repeated, {
      status: "skipped",
      postId: quote.id,
      noteSourceId,
      postIri: quote.iri,
      reason: "already-pending",
    });
    assert.equal(sent.length, 1);
  });
});

test("batch discovery finds every unattested legacy quote and dry-run stays read-only", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "batchquoteauthor",
      name: "Batch Quote Author",
      email: "batchquoteauthor@example.com",
    });
    const localTargetAuthor = await insertAccountWithActor(tx, {
      username: "batchlocaltarget",
      name: "Batch Local Target",
      email: "batchlocaltarget@example.com",
    });
    const remoteActor = await insertRemoteActor(tx, {
      username: "batchremotetarget",
      name: "Batch Remote Target",
      host: "remote.example",
    });
    const blockedRemoteActor = await insertRemoteActor(tx, {
      username: "batchblockedtarget",
      name: "Batch Blocked Target",
      host: "blocked.example",
    });
    const remoteTarget = await insertRemotePost(tx, {
      actorId: remoteActor.id,
    });
    const blockedRemoteTarget = await insertRemotePost(tx, {
      actorId: blockedRemoteActor.id,
    });
    const { post: localTarget } = await insertNotePost(tx, {
      account: localTargetAuthor.account,
      content: "Local target",
    });
    const { post: remoteQuote } = await insertNotePost(tx, {
      account: author.account,
      content: "Remote quote",
      quotedPostId: remoteTarget.id,
    });
    const { post: localQuote } = await insertNotePost(tx, {
      account: author.account,
      content: "Local quote",
      quotedPostId: localTarget.id,
    });
    const { post: privateQuote } = await insertNotePost(tx, {
      account: author.account,
      content: "Private remote quote",
      quotedPostId: remoteTarget.id,
      visibility: "direct",
    });
    const { post: authorizedQuote } = await insertNotePost(tx, {
      account: author.account,
      content: "Already authorized quote",
      quotedPostId: remoteTarget.id,
    });
    const suspendedAuthor = await insertAccountWithActor(tx, {
      username: "batchsuspendedauthor",
      name: "Batch Suspended Author",
      email: "batchsuspendedauthor@example.com",
    });
    const { post: suspendedAuthorQuote } = await insertNotePost(tx, {
      account: suspendedAuthor.account,
      content: "Quote from a suspended author",
      quotedPostId: remoteTarget.id,
    });
    const { post: blockedTargetQuote } = await insertNotePost(tx, {
      account: author.account,
      content: "Quote of a federation-blocked actor",
      quotedPostId: blockedRemoteTarget.id,
    });
    const suspended = new Date(Date.now() - 60_000);
    await tx
      .update(actorTable)
      .set({ suspended, suspendedUntil: null })
      .where(eq(actorTable.id, suspendedAuthor.actor.id));
    await tx
      .update(actorTable)
      .set({ suspended, suspendedUntil: null })
      .where(eq(actorTable.id, blockedRemoteActor.id));
    await tx
      .update(postTable)
      .set({ quoteAuthorizationIri: "https://remote.example/authorization" })
      .where(eq(postTable.id, authorizedQuote.id));

    const candidates = await findQuoteAuthorizationRerequestPostIds(tx);
    assert.equal(candidates.includes(remoteQuote.id), true);
    assert.equal(candidates.includes(localQuote.id), false);
    assert.equal(candidates.includes(privateQuote.id), true);
    assert.equal(candidates.includes(authorizedQuote.id), false);

    const fedCtx = createFedCtx(
      tx,
    ) as unknown as ApplicationContext<Transaction>;
    const eligible = await rerequestQuoteAuthorization(fedCtx, remoteQuote.id, {
      dryRun: true,
    });
    assert.equal(eligible.status, "eligible");
    const unchanged = await tx.query.postTable.findFirst({
      where: { id: remoteQuote.id },
    });
    assert.equal(unchanged?.quoteTargetState, null);
    const request = await tx.query.quoteRequestTable.findFirst({
      where: { quotePostId: remoteQuote.id },
    });
    assert.equal(request, undefined);

    const skipped = await rerequestQuoteAuthorization(fedCtx, localQuote.id, {
      dryRun: true,
    });
    assert.equal(skipped.status, "skipped");
    assert.equal(
      skipped.status === "skipped" && skipped.reason,
      "local-target",
    );
    const skippedPrivateQuote = await rerequestQuoteAuthorization(
      fedCtx,
      privateQuote.id,
      { dryRun: true },
    );
    assert.equal(
      skippedPrivateQuote.status === "skipped" && skippedPrivateQuote.reason,
      "private-quote",
    );
    const skippedSuspendedAuthor = await rerequestQuoteAuthorization(
      fedCtx,
      suspendedAuthorQuote.id,
      { dryRun: true },
    );
    assert.equal(
      skippedSuspendedAuthor.status === "skipped" &&
        skippedSuspendedAuthor.reason,
      "suspended-author",
    );
    const skippedBlockedTarget = await rerequestQuoteAuthorization(
      fedCtx,
      blockedTargetQuote.id,
      { dryRun: true },
    );
    assert.equal(
      skippedBlockedTarget.status === "skipped" && skippedBlockedTarget.reason,
      "blocked-target",
    );
  });
});

test("rerequestQuoteAuthorization() sends Questions and skips missing polls", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "legacyquestionauthor",
      name: "Legacy Question Author",
      email: "legacyquestionauthor@example.com",
    });
    const remoteActor = await insertRemoteActor(tx, {
      username: "legacyquestiontarget",
      name: "Legacy Question Target",
      host: "remote.example",
    });
    const target = await insertRemotePost(tx, { actorId: remoteActor.id });
    const { post: question } = await insertNotePost(tx, {
      account: author.account,
      content: "Which authorization path?",
      quotedPostId: target.id,
    });
    const { post: questionWithoutPoll } = await insertNotePost(tx, {
      account: author.account,
      content: "Missing poll",
      quotedPostId: target.id,
    });
    await tx
      .update(postTable)
      .set({ type: "Question", name: "Which authorization path?" })
      .where(eq(postTable.id, question.id));
    await tx
      .update(postTable)
      .set({ type: "Question", name: "Missing poll" })
      .where(eq(postTable.id, questionWithoutPoll.id));
    await tx.insert(pollTable).values({
      postId: question.id,
      multiple: false,
      votersCount: 0,
      ends: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await tx.insert(pollOptionTable).values([
      {
        postId: question.id,
        index: 0,
        title: "Automatic",
        votesCount: 0,
      },
      {
        postId: question.id,
        index: 1,
        title: "Manual",
        votesCount: 0,
      },
    ]);
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as ApplicationContext<Transaction>;

    const requested = await rerequestQuoteAuthorization(fedCtx, question.id);
    assert.equal(requested.status, "requested");
    const request = sent[0][2];
    assert.ok(request instanceof QuoteRequest);
    const instrument = await request.getInstrument({
      ...fedCtx,
      suppressError: true,
    });
    assert.ok(instrument instanceof ActivityPubQuestion);
    assert.equal(instrument.name?.toString(), "Which authorization path?");
    const options = await Array.fromAsync(instrument.getExclusiveOptions());
    assert.equal(options.length, 2);

    const missingPoll = await rerequestQuoteAuthorization(
      fedCtx,
      questionWithoutPoll.id,
      { dryRun: true },
    );
    assert.equal(
      missingPoll.status === "skipped" && missingPoll.reason,
      "missing-poll",
    );
  });
});

test("rerequestQuoteAuthorization() honors blocks in both directions", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "blockedquoteauthor",
      name: "Blocked Quote Author",
      email: "blockedquoteauthor@example.com",
    });
    const locallyBlockedActor = await insertRemoteActor(tx, {
      username: "locallyblockedtarget",
      name: "Locally Blocked Target",
      host: "locally-blocked.example",
    });
    const remotelyBlockingActor = await insertRemoteActor(tx, {
      username: "remotelyblockingtarget",
      name: "Remotely Blocking Target",
      host: "remotely-blocking.example",
    });
    const locallyBlockedTarget = await insertRemotePost(tx, {
      actorId: locallyBlockedActor.id,
    });
    const remotelyBlockingTarget = await insertRemotePost(tx, {
      actorId: remotelyBlockingActor.id,
    });
    const { post: locallyBlockedQuote } = await insertNotePost(tx, {
      account: author.account,
      content: "Quote of a locally blocked actor",
      quotedPostId: locallyBlockedTarget.id,
    });
    const { post: remotelyBlockingQuote } = await insertNotePost(tx, {
      account: author.account,
      content: "Quote of an actor who blocked the author",
      quotedPostId: remotelyBlockingTarget.id,
    });
    await tx.insert(blockingTable).values([
      {
        id: generateUuidV7(),
        iri: "http://localhost/blocks/locally-blocked-target",
        blockerId: author.actor.id,
        blockeeId: locallyBlockedActor.id,
      },
      {
        id: generateUuidV7(),
        iri: "https://remotely-blocking.example/blocks/author",
        blockerId: remotelyBlockingActor.id,
        blockeeId: author.actor.id,
      },
    ]);

    const fedCtx = createFedCtx(
      tx,
    ) as unknown as ApplicationContext<Transaction>;
    const locallyBlocked = await rerequestQuoteAuthorization(
      fedCtx,
      locallyBlockedQuote.id,
      { dryRun: true },
    );
    const remotelyBlocking = await rerequestQuoteAuthorization(
      fedCtx,
      remotelyBlockingQuote.id,
      { dryRun: true },
    );

    assert.equal(
      locallyBlocked.status === "skipped" && locallyBlocked.reason,
      "blocked-relationship",
    );
    assert.equal(
      remotelyBlocking.status === "skipped" && remotelyBlocking.reason,
      "blocked-relationship",
    );
  });
});
