import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import type { Context } from "@fedify/fedify";
import { Create, Note as ActivityPubNote, QuoteRequest } from "@fedify/vocab";
import type { ContextData } from "./context.ts";
import type { Transaction } from "./db.ts";
import { createNote, QuotePolicyDeniedError, updateNote } from "./note.ts";
import { followingTable, mediumTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("createNote() creates a post and timeline entry for the author", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "createnoteauthor",
      name: "Create Note Author",
      email: "createnoteauthor@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");

    const note = await createNote(
      fedCtx as unknown as Context<ContextData<Transaction>>,
      {
        accountId: author.account.id,
        visibility: "public",
        content: "Hello **world**",
        language: "en",
        media: [],
        published,
        updated: published,
      },
    );

    assert.ok(note != null);
    assert.equal(note.noteSource.accountId, author.account.id);
    assert.equal(note.noteSource.content, "Hello **world**");
    assert.equal(note.actor.id, author.actor.id);
    assert.equal(note.noteSourceId, note.noteSource.id);
    assert.match(note.contentHtml, /<strong>world<\/strong>/);
    assert.deepEqual(note.media, []);

    const timelineItem = await tx.query.timelineItemTable.findFirst({
      where: {
        accountId: author.account.id,
        postId: note.id,
      },
    });
    assert.ok(timelineItem != null);
    assert.equal(timelineItem.originalAuthorId, author.actor.id);
    assert.equal(timelineItem.lastSharerId, null);
    assert.equal(timelineItem.sharersCount, 0);
  });
});

test("createNote() allows the same medium at multiple indexes", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "duplicatenotemedia",
      name: "Duplicate Note Media",
      email: "duplicatenotemedia@example.com",
    });
    const [medium] = await tx.insert(mediumTable).values({
      id: generateUuidV7(),
      key: "note-media/duplicate.webp",
      type: "image/webp",
      width: 320,
      height: 180,
    }).returning();

    const note = await createNote(
      fedCtx as unknown as Context<ContextData<Transaction>>,
      {
        accountId: author.account.id,
        visibility: "public",
        content: "Same image twice",
        language: "en",
        media: [
          { mediumId: medium.id, alt: "First occurrence" },
          { mediumId: medium.id, alt: "Second occurrence" },
        ],
      },
    );

    assert.ok(note != null);
    assert.equal(note.noteSource.media.length, 2);
    assert.equal(note.noteSource.media[0].index, 0);
    assert.equal(note.noteSource.media[0].mediumId, medium.id);
    assert.equal(note.noteSource.media[0].alt, "First occurrence");
    assert.equal(note.noteSource.media[1].index, 1);
    assert.equal(note.noteSource.media[1].mediumId, medium.id);
    assert.equal(note.noteSource.media[1].alt, "Second occurrence");
    assert.equal(note.media.length, 2);
  });
});

test("createNote() fails when a requested medium cannot be attached", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "missingnotemedia",
      name: "Missing Note Media",
      email: "missingnotemedia@example.com",
    });

    const note = await createNote(
      fedCtx as unknown as Context<ContextData<Transaction>>,
      {
        accountId: author.account.id,
        visibility: "public",
        content: "Missing image",
        language: "en",
        media: [
          { mediumId: generateUuidV7(), alt: "Missing medium" },
        ],
      },
    );

    assert.equal(note, undefined);
  });
});

test("createNote() stores tags relayed to tags.pub only for public posts", async () => {
  await withTagsPubRelayEnabled(async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "relayedtagsauthor",
        name: "Relayed Tags Author",
        email: "relayedtagsauthor@example.com",
      });
      const published = new Date("2026-04-15T00:00:00.000Z");

      const publicNote = await createNote(
        fedCtx as unknown as Context<ContextData<Transaction>>,
        {
          accountId: author.account.id,
          visibility: "public",
          content: "Hello #Fediverse",
          language: "en",
          media: [],
          published,
          updated: published,
        },
      );
      const followersNote = await createNote(
        fedCtx as unknown as Context<ContextData<Transaction>>,
        {
          accountId: author.account.id,
          visibility: "followers",
          content: "Private #Fediverse",
          language: "en",
          media: [],
          published,
          updated: published,
        },
      );

      assert.ok(publicNote != null);
      assert.deepEqual(publicNote.relayedTags, ["fediverse"]);
      assert.ok(followersNote != null);
      assert.deepEqual(followersNote.relayedTags, []);
    });
  });
});

test("createNote() enforces quote policy for legacy callers", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "quoteprivatetarget",
      name: "Quote Private Target",
      email: "quoteprivatetarget@example.com",
    });
    const follower = await insertAccountWithActor(tx, {
      username: "quoteprivatefollower",
      name: "Quote Private Follower",
      email: "quoteprivatefollower@example.com",
    });
    await tx.insert(followingTable).values({
      iri: `http://localhost/follows/${follower.actor.id}`,
      followerId: follower.actor.id,
      followeeId: author.actor.id,
      accepted: new Date("2026-04-15T00:00:00.000Z"),
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      visibility: "followers",
      quotePolicy: "self",
      content: "Followers-only target",
    });

    await assert.rejects(
      () =>
        createNote(
          fedCtx as unknown as Context<ContextData<Transaction>>,
          {
            accountId: follower.account.id,
            visibility: "public",
            content: "Trying to quote a followers-only post",
            language: "en",
            media: [],
          },
          { quotedPost: { ...quotedPost, actor: author.actor } },
        ),
      QuotePolicyDeniedError,
    );

    const refreshedTarget = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.equal(refreshedTarget?.quotesCount, 0);
    const authorization = await tx.query.quoteAuthorizationTable.findFirst({
      where: { quotedPostId: quotedPost.id },
    });
    assert.equal(authorization, undefined);
    const orphanedSource = await tx.query.noteSourceTable.findFirst({
      where: { content: "Trying to quote a followers-only post" },
    });
    assert.equal(orphanedSource, undefined);
  });
});

test("createNote() rejects direct quote targets for legacy callers", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "quotedirecttarget",
      name: "Quote Direct Target",
      email: "quotedirecttarget@example.com",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      visibility: "direct",
      quotePolicy: "self",
      content: "Direct target",
    });

    await assert.rejects(
      () =>
        createNote(
          fedCtx as unknown as Context<ContextData<Transaction>>,
          {
            accountId: author.account.id,
            visibility: "public",
            content: "Trying to quote a direct post",
            language: "en",
            media: [],
          },
          { quotedPost: { ...quotedPost, actor: author.actor } },
        ),
      QuotePolicyDeniedError,
    );

    const refreshedTarget = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.equal(refreshedTarget?.quotesCount, 0);
    const orphanedSource = await tx.query.noteSourceTable.findFirst({
      where: { content: "Trying to quote a direct post" },
    });
    assert.equal(orphanedSource, undefined);
  });
});

test("createNote() federates the normalized quote target for shares", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quoteshareoriginal",
      name: "Quote Share Original",
      email: "quoteshareoriginal@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "quotesharesharer",
      name: "Quote Share Sharer",
      email: "quotesharesharer@example.com",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quotesharequoter",
      name: "Quote Share Quoter",
      email: "quotesharequoter@example.com",
    });
    const { post: original } = await insertNotePost(tx, {
      account: author.account,
      content: "Original quote target",
    });
    const { post: share } = await insertNotePost(tx, {
      account: sharer.account,
      content: "Share wrapper",
      sharedPostId: original.id,
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as Context<ContextData<Transaction>>;

    const quote = await createNote(fedCtx, {
      accountId: quoter.account.id,
      visibility: "public",
      content: "Quoting a share wrapper",
      language: "en",
      media: [],
    }, { quotedPost: { ...share, actor: sharer.actor } });

    assert.ok(quote != null);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: quote.id },
    });
    assert.equal(storedQuote?.quotedPostId, original.id);
    const create = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof Create);
    assert.ok(create instanceof Create);
    const createdObject = await create.getObject({
      ...fedCtx,
      suppressError: true,
    });
    assert.ok(createdObject instanceof ActivityPubNote);
    assert.equal(createdObject.quoteId?.href, original.iri);
    assert.equal(createdObject.quoteUrl?.href, original.iri);
  });
});

test("createNote() keeps pending quote requests out of confirmed quote state", async () => {
  await withRollback(async (tx) => {
    const targetAuthor = await insertAccountWithActor(tx, {
      username: "pendingquotetarget",
      name: "Pending Quote Target",
      email: "pendingquotetarget@example.com",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "pendingquotequoter",
      name: "Pending Quote Quoter",
      email: "pendingquotequoter@example.com",
    });
    const { post: target } = await insertNotePost(tx, {
      account: targetAuthor.account,
      content: "Manual approval target",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as Context<ContextData<Transaction>>;

    const quote = await createNote(fedCtx, {
      accountId: quoter.account.id,
      visibility: "public",
      content: "Requesting quote approval",
      language: "en",
      media: [],
    }, { quotedPost: { ...target, actor: targetAuthor.actor } });

    assert.ok(quote != null);
    const returnedQuote = quote as typeof quote & {
      quotedPost: unknown;
      quoteRequestRequired: boolean;
    };
    assert.equal(quote.quotedPostId, null);
    assert.equal(returnedQuote.quotedPost, null);
    assert.equal(returnedQuote.quoteRequestRequired, true);
    const requestRow = await tx.query.quoteRequestTable.findFirst({
      where: { quotePostId: quote.id },
    });
    assert.equal(requestRow?.quotedPostId, target.id);
    assert.equal(
      sent.some((args) => args[2] instanceof QuoteRequest),
      true,
    );
    const quoteNotification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: targetAuthor.account.id,
        postId: quote.id,
        type: "quote",
      },
    });
    assert.equal(quoteNotification, undefined);
  });
});

test("updateNote() updates the persisted post for an existing note source", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "updatenoteauthor",
      name: "Update Note Author",
      email: "updatenoteauthor@example.com",
    });
    const original = await createNote(
      fedCtx as unknown as Context<ContextData<Transaction>>,
      {
        accountId: author.account.id,
        visibility: "public",
        content: "Original note body",
        language: "en",
        media: [],
        published: new Date("2026-04-15T00:00:00.000Z"),
        updated: new Date("2026-04-15T00:00:00.000Z"),
      },
    );
    assert.ok(original != null);

    const updated = await updateNote(fedCtx, original.noteSource.id, {
      content: "Updated _note_ body",
      language: "ko",
    });

    assert.ok(updated != null);
    assert.equal(updated.id, original.id);
    assert.equal(updated.noteSource.id, original.noteSource.id);
    assert.equal(updated.noteSource.content, "Updated _note_ body");
    assert.equal(updated.noteSource.language, "ko");
    assert.match(updated.contentHtml, /<em>note<\/em>/);

    const storedPost = await tx.query.postTable.findFirst({
      where: { id: original.id },
    });
    assert.ok(storedPost != null);
    assert.equal(storedPost.noteSourceId, original.noteSource.id);
    assert.equal(storedPost.language, "ko");
    assert.match(storedPost.contentHtml, /<em>note<\/em>/);
  });
});

async function withTagsPubRelayEnabled(
  run: () => Promise<void>,
): Promise<void> {
  const previous = process.env.TAGS_PUB_RELAY;
  process.env.TAGS_PUB_RELAY = "true";
  try {
    await run();
  } finally {
    if (previous == null) {
      delete process.env.TAGS_PUB_RELAY;
    } else {
      process.env.TAGS_PUB_RELAY = previous;
    }
  }
}
