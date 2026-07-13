import assert from "node:assert";
import test from "node:test";
import { Create, Note as ActivityPubNote, QuoteRequest } from "@fedify/vocab";
import { eq } from "drizzle-orm";
import type { ApplicationContext } from "./context.ts";
import type { Transaction } from "./db.ts";
import { createNote, QuotePolicyDeniedError, updateNote } from "./note.ts";
import { createQuestion } from "./question.ts";
import {
  followingTable,
  mediumTable,
  organizationPostAuthorTable,
  postTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import { withTagsPubRelayEnabled } from "../test/env.ts";
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
      fedCtx as unknown as ApplicationContext<Transaction>,
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

test("createNote() applies post-created hooks before federation", async () => {
  await withRollback(async (tx) => {
    const member = await insertAccountWithActor(tx, {
      username: "createnotecoauthor",
      name: "Create Note Co-author",
      email: "createnotecoauthor@example.com",
    });
    const organization = await insertAccountWithActor(tx, {
      username: "createnoteorg",
      name: "Create Note Organization",
      email: "createnoteorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as ApplicationContext<Transaction>;

    const note = await createNote(
      fedCtx,
      {
        accountId: organization.account.id,
        visibility: "public",
        content: "Co-authored note",
        language: "en",
        media: [],
      },
      {},
      {
        async afterPostCreated(post) {
          await tx.insert(organizationPostAuthorTable).values({
            postId: post.id,
            organizationAccountId: organization.account.id,
            memberAccountId: member.account.id,
            attributionMode: "acting_account_with_viewer",
          });
        },
      },
    );

    assert.ok(note != null);
    const create = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof Create);
    assert.ok(create instanceof Create);
    assert.deepEqual(
      create.actorIds.map((id) => id.href),
      [`http://localhost/actors/${organization.account.id}`],
    );
    const object = await create.getObject({ ...fedCtx, suppressError: true });
    assert.ok(object instanceof ActivityPubNote);
    assert.deepEqual(
      object.attributionIds.map((id) => id.href),
      [
        `http://localhost/actors/${organization.account.id}`,
        `http://localhost/actors/${member.account.id}`,
      ],
    );
  });
});

test("updateNote() does not federate a censored post", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "censorededitnote",
      name: "Censored Edit Note",
      email: "censorededitnote@example.com",
    });
    const { noteSourceId, post } = await insertNotePost(tx, {
      account: author.account,
      content: "Original body",
    });
    // Moderators censor the post without suspending the author.
    await tx.update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, post.id));

    const fedCtx = createFedCtx(tx);
    const sent: unknown[] = [];
    // deno-lint-ignore no-explicit-any
    (fedCtx as any).sendActivity = (...args: unknown[]) => {
      sent.push(args);
      return Promise.resolve();
    };
    const updated = await updateNote(fedCtx, noteSourceId, {
      content: "Edited body",
    });

    // The local edit persists, but a censored post pushes nothing out over
    // federation (no Update to mentions, followers, or tag relays).
    assert.ok(updated != null);
    assert.equal(updated.noteSource.content, "Edited body");
    assert.equal(sent.length, 0);
  });
});

test("updateNote() notifies local sharers when the body changes", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "updatenoteshareauthor",
      name: "Update Note Share Author",
      email: "updatenoteshareauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "updatenotesharer",
      name: "Update Note Sharer",
      email: "updatenotesharer@example.com",
    });
    const { noteSourceId, post } = await insertNotePost(tx, {
      account: author.account,
      content: "Original shared body",
    });
    await insertNotePost(tx, {
      account: sharer.account,
      content: "",
      sharedPostId: post.id,
    });

    await updateNote(fedCtx, noteSourceId, {
      content: "Updated shared body",
    });

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: sharer.account.id,
        type: "shared_post_updated",
        postId: post.id,
      },
    });
    assert.ok(notification != null);
    assert.deepEqual(notification.actorIds, [author.actor.id]);
  });
});

test("updateNote() notifies local quoters when the body changes", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "updatenotequoteauthor",
      name: "Update Note Quote Author",
      email: "updatenotequoteauthor@example.com",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "updatenotequoter",
      name: "Update Note Quoter",
      email: "updatenotequoter@example.com",
    });
    const { noteSourceId, post } = await insertNotePost(tx, {
      account: author.account,
      content: "Original quoted body",
    });
    await insertNotePost(tx, {
      account: quoter.account,
      content: "I agree with this",
      quotedPostId: post.id,
    });

    await updateNote(fedCtx, noteSourceId, {
      content: "Updated quoted body",
    });

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: quoter.account.id,
        type: "quoted_post_updated",
        postId: post.id,
      },
    });
    assert.ok(notification != null);
    assert.deepEqual(notification.actorIds, [author.actor.id]);
  });
});

test("updateNote() keeps separate share and quote update notifications", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "updatenotebothauthor",
      name: "Update Note Both Author",
      email: "updatenotebothauthor@example.com",
    });
    const account = await insertAccountWithActor(tx, {
      username: "updatenotebothrecipient",
      name: "Update Note Both Recipient",
      email: "updatenotebothrecipient@example.com",
    });
    const { noteSourceId, post } = await insertNotePost(tx, {
      account: author.account,
      content: "Original shared and quoted body",
    });
    await insertNotePost(tx, {
      account: account.account,
      content: "",
      sharedPostId: post.id,
    });
    await insertNotePost(tx, {
      account: account.account,
      content: "I also quote this",
      quotedPostId: post.id,
    });

    await updateNote(fedCtx, noteSourceId, {
      content: "Updated shared and quoted body",
    });

    const notifications = await tx.query.notificationTable.findMany({
      where: {
        accountId: account.account.id,
        postId: post.id,
      },
    });
    assert.deepEqual(
      notifications.map((notification) => notification.type).sort(),
      ["quoted_post_updated", "shared_post_updated"],
    );
  });
});

test("updateNote() does not notify sharers when only quote policy changes", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "updatenotepolicyauthor",
      name: "Update Note Policy Author",
      email: "updatenotepolicyauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "updatenotepolicysharer",
      name: "Update Note Policy Sharer",
      email: "updatenotepolicysharer@example.com",
    });
    const post = await createNote(
      fedCtx as unknown as ApplicationContext<Transaction>,
      {
        accountId: author.account.id,
        visibility: "public",
        content: "Policy-only target",
        language: "en",
        media: [],
      },
    );
    assert.ok(post != null);
    await insertNotePost(tx, {
      account: sharer.account,
      content: "",
      sharedPostId: post.id,
    });

    await updateNote(fedCtx, post.noteSource.id, {
      quotePolicy: "followers",
    });

    const notifications = await tx.query.notificationTable.findMany({
      where: {
        accountId: sharer.account.id,
        type: "shared_post_updated",
        postId: post.id,
      },
    });
    assert.equal(notifications.length, 0);
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
      fedCtx as unknown as ApplicationContext<Transaction>,
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
      fedCtx as unknown as ApplicationContext<Transaction>,
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
        fedCtx as unknown as ApplicationContext<Transaction>,
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
        fedCtx as unknown as ApplicationContext<Transaction>,
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
          fedCtx as unknown as ApplicationContext<Transaction>,
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
          fedCtx as unknown as ApplicationContext<Transaction>,
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
    } as unknown as ApplicationContext<Transaction>;

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
    } as unknown as ApplicationContext<Transaction>;

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
      fedCtx as unknown as ApplicationContext<Transaction>,
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

test("updateNote() rejects existing Question sources before changing content", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "updatequestionauthor",
      name: "Update Question Author",
      email: "updatequestionauthor@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");
    const question = await createQuestion(
      fedCtx as unknown as ApplicationContext<Transaction>,
      {
        accountId: author.account.id,
        visibility: "public",
        quotePolicy: "everyone",
        content: "Question body should stay immutable",
        language: "en",
        media: [],
        published,
        updated: published,
        poll: {
          title: "Immutable poll",
          multiple: false,
          options: ["Yes", "No"],
          ends: new Date("2026-04-16T00:00:00.000Z"),
          now: published,
        },
      },
    );
    assert.ok(question != null);

    const updated = await updateNote(fedCtx, question.noteSource.id, {
      content: "This should not be written",
    });

    assert.equal(updated, undefined);
    const source = await tx.query.noteSourceTable.findFirst({
      where: { id: question.noteSource.id },
    });
    assert.equal(source?.content, "Question body should stay immutable");
  });
});
