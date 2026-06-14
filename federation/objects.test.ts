import assert from "node:assert";
import test from "node:test";
import type { Context } from "@fedify/fedify";
import { MemoryKvStore } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import { createQuestion } from "@hackerspub/models/question";
import {
  actorTable,
  postTable,
  quoteAuthorizationTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq } from "drizzle-orm";
import { builder } from "./builder.ts";
import { getCreate, getNote, isApTargetHidden } from "./objects.ts";
import {
  createFedCtx,
  createTestDisk,
  createTestKv,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

test("getNote() normalizes quote policy for non-public notes", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "normalizedquotenote",
      name: "Normalized Quote Note",
      email: "normalizedquotenote@example.com",
    });
    const { noteSourceId } = await insertNotePost(tx, {
      account: author.account,
      visibility: "followers",
      quotePolicy: "everyone",
      content: "Followers-only note",
    });
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: true,
        media: { with: { medium: true }, orderBy: { index: "asc" } },
      },
    });
    assert.ok(noteSource != null);

    const note = await getNote(createFedCtx(tx), noteSource);

    assert.equal(
      note.interactionPolicy?.canQuote?.automaticApprovals[0].href,
      `http://localhost/actors/${author.account.id}`,
    );
  });
});

test("getNote() omits quote policy for direct notes", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "directquotenote",
      name: "Direct Quote Note",
      email: "directquotenote@example.com",
    });
    const { noteSourceId } = await insertNotePost(tx, {
      account: author.account,
      visibility: "direct",
      quotePolicy: "self",
      content: "Direct note",
    });
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: true,
        media: { with: { medium: true }, orderBy: { index: "asc" } },
      },
    });
    assert.ok(noteSource != null);

    const note = await getNote(createFedCtx(tx), noteSource);

    assert.equal(note.interactionPolicy == null, true);
  });
});

test("source-backed Questions do not resolve through the Note dispatcher", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "questionnotedispatch",
      name: "Question Note Dispatch",
      email: "questionnotedispatch@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");
    const question = await createQuestion(
      createFedCtx(tx) as unknown as Context<ContextData<Transaction>>,
      {
        accountId: author.account.id,
        visibility: "public",
        quotePolicy: "everyone",
        content: "Should resolve only as a Question",
        language: "en",
        media: [],
        published,
        updated: published,
        poll: {
          title: "Dispatcher type",
          multiple: false,
          options: ["Question", "Note"],
          ends: new Date("2026-04-16T00:00:00.000Z"),
          now: published,
        },
      },
    );
    assert.ok(question != null);

    const kv = createTestKv().kv;
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const contextData = {
      db: tx,
      kv,
      disk: createTestDisk(),
      models: {} as ContextData["models"],
    };

    const noteResponse = await federation.fetch(
      new Request(
        `http://localhost/ap/notes/${question.noteSource.id}`,
        { headers: { Accept: "application/activity+json" } },
      ),
      { contextData },
    );

    assert.ok(
      noteResponse.status >= 400 && noteResponse.status < 500,
      `expected Note dispatcher miss to return 4xx, got ${noteResponse.status}`,
    );
  });
});

test("isApTargetHidden() hides censored or sanction-hidden reply/quote targets", async () => {
  await withRollback(async (tx) => {
    // The Note and Question dispatchers drop a reply/quote target's
    // `inReplyTo`/quote IRI when this returns `true`, so the ActivityPub
    // object never points federated readers at moderation-hidden content
    // (for a remote target, the uncensored copy on its origin).
    const remoteAuthor = await insertRemoteActor(tx, {
      username: "aptarget",
      name: "AP Target",
      host: "remote.example",
    });
    const target = await insertRemotePost(tx, { actorId: remoteAuthor.id });
    const load = () =>
      tx.query.postTable.findFirst({
        where: { id: target.id },
        with: { actor: true },
      });

    // A null target and a plain visible one are not hidden.
    assert.equal(isApTargetHidden(null), false);
    assert.equal(isApTargetHidden(await load()), false);

    // A censored target is hidden.
    await tx.update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, target.id));
    assert.equal(isApTargetHidden(await load()), true);

    // So is a target whose author is hidden by a federation block, even when
    // the post itself is not individually censored.
    await tx.update(postTable)
      .set({ censored: null })
      .where(eq(postTable.id, target.id));
    await tx.update(actorTable)
      .set({ suspended: new Date(Date.now() - 1000), suspendedUntil: null })
      .where(eq(actorTable.id, remoteAuthor.id));
    assert.equal(isApTargetHidden(await load()), true);
  });
});

test("getCreate() returns a Create activity with a dereferenceable id", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "createtest",
      name: "Create Test",
      email: "createtest@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "TDD",
    });
    const postWithRels = await tx.query.postTable.findFirst({
      where: { id: post.id },
      with: {
        actor: { with: { account: true } },
        mentions: { with: { actor: true } },
      },
    });
    assert.ok(postWithRels != null && postWithRels.actor.account != null);

    const create = getCreate(createFedCtx(tx), {
      ...postWithRels,
      actor: { ...postWithRels.actor, account: postWithRels.actor.account },
    });

    assert.ok(create.id != null);
    assert.equal(create.id.hash, "");
    assert.equal(create.id.href, `http://localhost/objects/${post.id}`);
  });
});

test("getCreate() sets actor, object, and published correctly", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "createtest2",
      name: "Create Test 2",
      email: "createtest2@example.com",
    });
    const published = new Date("2026-03-01T12:00:00Z");
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Hello",
      published,
    });
    const postWithRels = await tx.query.postTable.findFirst({
      where: { id: post.id },
      with: {
        actor: { with: { account: true } },
        mentions: { with: { actor: true } },
      },
    });
    assert.ok(postWithRels != null && postWithRels.actor.account != null);

    const create = getCreate(createFedCtx(tx), {
      ...postWithRels,
      actor: { ...postWithRels.actor, account: postWithRels.actor.account },
    });

    assert.equal(
      create.actorId?.href,
      `http://localhost/actors/${author.account.id}`,
    );
    assert.equal(
      create.objectId?.href,
      `http://localhost/objects/${post.id}`,
    );
    assert.ok(create.published != null);
  });
});

test("getNote() advertises manual quote approvals", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "manualquotenote",
      name: "Manual Quote Note",
      email: "manualquotenote@example.com",
    });
    const { noteSourceId } = await insertNotePost(tx, {
      account: author.account,
      quotePolicy: "self",
      content: "Manual quote note",
    });
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: true,
        media: { with: { medium: true }, orderBy: { index: "asc" } },
      },
    });
    assert.ok(noteSource != null);

    const note = await getNote(createFedCtx(tx), noteSource, {
      quoteRequestPolicy: "everyone",
    });

    assert.equal(
      note.interactionPolicy?.canQuote?.manualApprovals[0].href,
      "https://www.w3.org/ns/activitystreams#Public",
    );
  });
});

test("the quote-authorization dispatcher hides censored posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quoteauthcensor",
      name: "Quote Auth Censor",
      email: "quoteauthcensor@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Quotable until censored",
    });
    const authId = generateUuidV7();
    await tx.insert(quoteAuthorizationTable).values({
      id: authId,
      iri: `http://localhost/ap/quote-authorizations/${authId}`,
      quotePostIri: "https://remote.example/objects/quote",
      quotedPostId: post.id,
      attributedActorId: author.actor.id,
    });

    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const contextData = {
      db: tx,
      kv: createTestKv().kv,
      disk: createTestDisk(),
      models: {} as ContextData["models"],
    };
    const url = `http://localhost/ap/quote-authorizations/${authId}`;

    await tx.update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, post.id));

    // Once censored, the authorize callback denies the request (Fedify
    // serves 404) before any key/document-loader work, so remote instances
    // can no longer keep validating the already-issued quote.  (Without the
    // censorship guard this same request reaches getDocumentLoader instead,
    // which this unit harness cannot satisfy because it registers no
    // key-pairs dispatcher, so the visible-post path is not reproducible
    // here.)
    const after = await federation.fetch(
      new Request(url, { headers: { Accept: "application/activity+json" } }),
      { contextData },
    );
    assert.equal(after.status, 404);
  });
});

test("getNote() drops the quote authorization when the target is absent", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quoteauthnote",
      name: "Quote Auth Note",
      email: "quoteauthnote@example.com",
    });
    const { noteSourceId } = await insertNotePost(tx, {
      account: author.account,
      content: "Quoting note",
    });
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: true,
        media: { with: { medium: true }, orderBy: { index: "asc" } },
      },
    });
    assert.ok(noteSource != null);
    const { post: target } = await insertNotePost(tx, {
      account: author.account,
      content: "Quote target",
    });
    const authIri = "http://localhost/ap/quote-authorizations/note-auth";

    // With a visible quote target, both the quote and its authorization are
    // emitted.
    const withTarget = await getNote(createFedCtx(tx), noteSource, {
      quotedPost: target,
      quoteAuthorizationIri: authIri,
    });
    assert.equal(withTarget.quoteId?.href, target.iri);
    assert.equal(withTarget.quoteAuthorizationId?.href, authIri);

    // When the target is dropped (the dispatcher does this for a censored or
    // sanction-hidden quote), the authorization URL must not be emitted on
    // its own, or it would stay dereferenceable for the hidden target.
    const withoutTarget = await getNote(createFedCtx(tx), noteSource, {
      quoteAuthorizationIri: authIri,
    });
    assert.equal(withoutTarget.quoteId, null);
    assert.equal(withoutTarget.quoteAuthorizationId, null);
  });
});
