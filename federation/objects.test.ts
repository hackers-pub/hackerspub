import assert from "node:assert";
import test from "node:test";
import type { Context } from "@fedify/fedify";
import { MemoryKvStore } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import { createQuestion } from "@hackerspub/models/question";
import {
  actorTable,
  articleContentTable,
  articleSourceTable,
  organizationPostAuthorTable,
  postTable,
  quoteAuthorizationTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq } from "drizzle-orm";
import { builder } from "./builder.ts";
import {
  getArticle,
  getCreate,
  getNote,
  getQuestion,
  isApTargetHidden,
  isEmojiReactionCollectionVisible,
} from "./objects.ts";
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

test("getNote() includes member attribution for co-authored organization notes", async () => {
  await withRollback(async (tx) => {
    const member = await insertAccountWithActor(tx, {
      username: "notecoauthor",
      name: "Note Co-author",
      email: "notecoauthor@example.com",
    });
    const organization = await insertAccountWithActor(tx, {
      username: "noteorg",
      name: "Note Organization",
      email: "noteorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const { noteSourceId, post } = await insertNotePost(tx, {
      account: organization.account,
      content: "Co-authored note",
    });
    await tx.insert(organizationPostAuthorTable).values({
      postId: post.id,
      organizationAccountId: organization.account.id,
      memberAccountId: member.account.id,
      attributionMode: "acting_account_with_viewer",
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

    assert.deepEqual(
      note.attributionIds.map((id) => id.href),
      [
        `http://localhost/actors/${organization.account.id}`,
        `http://localhost/actors/${member.account.id}`,
      ],
    );
  });
});

test("getNote() advertises the emoji reactions collection", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "noteemojireactions",
      name: "Note Emoji Reactions",
      email: "noteemojireactions@example.com",
    });
    const { noteSourceId } = await insertNotePost(tx, {
      account: author.account,
      content: "React here",
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
      note.emojiReactionsId?.href,
      `http://localhost/ap/emoji-reactions/notes/${noteSourceId}`,
    );
  });
});

test("getArticle() includes member attribution for co-authored organization articles", async () => {
  await withRollback(async (tx) => {
    const member = await insertAccountWithActor(tx, {
      username: "articlecoauthor",
      name: "Article Co-author",
      email: "articlecoauthor@example.com",
    });
    const organization = await insertAccountWithActor(tx, {
      username: "articleorg",
      name: "Article Organization",
      email: "articleorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");
    const articleSourceId = generateUuidV7();
    const postId = generateUuidV7();
    await tx.insert(articleSourceTable).values({
      id: articleSourceId,
      accountId: organization.account.id,
      publishedYear: 2026,
      slug: "co-authored-article",
      quotePolicy: "everyone",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId: articleSourceId,
      language: "en",
      title: "Co-authored article",
      content: "Hello from an organization.",
      published,
      updated: published,
    });
    await tx.insert(postTable).values({
      id: postId,
      iri: `http://localhost/objects/${postId}`,
      type: "Article",
      visibility: "public",
      quotePolicy: "everyone",
      actorId: organization.actor.id,
      articleSourceId,
      name: "Co-authored article",
      contentHtml: "<p>Hello from an organization.</p>",
      language: "en",
      published,
      updated: published,
    });
    await tx.insert(organizationPostAuthorTable).values({
      postId,
      organizationAccountId: organization.account.id,
      memberAccountId: member.account.id,
      attributionMode: "acting_account_with_viewer",
    });
    const articleSource = await tx.query.articleSourceTable.findFirst({
      where: { id: articleSourceId },
      with: { account: true, contents: true },
    });
    assert.ok(articleSource != null);

    const article = await getArticle(createFedCtx(tx), articleSource);

    assert.deepEqual(
      article.attributionIds.map((id) => id.href),
      [
        `http://localhost/actors/${organization.account.id}`,
        `http://localhost/actors/${member.account.id}`,
      ],
    );
  });
});

test("getArticle() advertises the emoji reactions collection", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "articleemojireactions",
      name: "Article Emoji Reactions",
      email: "articleemojireactions@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");
    const articleSourceId = generateUuidV7();
    await tx.insert(articleSourceTable).values({
      id: articleSourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "emoji-reactions",
      quotePolicy: "everyone",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId: articleSourceId,
      language: "en",
      title: "Emoji reactions",
      content: "Article reactions",
      published,
      updated: published,
    });
    const articleSource = await tx.query.articleSourceTable.findFirst({
      where: { id: articleSourceId },
      with: { account: true, contents: true },
    });
    assert.ok(articleSource != null);

    const article = await getArticle(createFedCtx(tx), articleSource);

    assert.equal(
      article.emojiReactionsId?.href,
      `http://localhost/ap/emoji-reactions/articles/${articleSourceId}`,
    );
  });
});

test("getArticle() preserves article content titles when rendered body has no heading", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "articlebodytitle",
      name: "Article Body Title",
      email: "articlebodytitle@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");
    const articleSourceId = generateUuidV7();
    await tx.insert(articleSourceTable).values({
      id: articleSourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "body-without-heading",
      quotePolicy: "everyone",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values([
      {
        sourceId: articleSourceId,
        language: "ko",
        title: "본문 제목이 아닌 글 제목",
        content: "본문에는 별도의 H1 제목이 없습니다.",
        published,
        updated: published,
      },
      {
        sourceId: articleSourceId,
        language: "en",
        title: "Article title, not body title",
        content: "The body has no separate H1 heading.",
        originalLanguage: "ko",
        translationRequesterId: author.account.id,
        published: new Date("2026-04-15T00:01:00.000Z"),
        updated: new Date("2026-04-15T00:01:00.000Z"),
      },
    ]);
    const articleSource = await tx.query.articleSourceTable.findFirst({
      where: { id: articleSourceId },
      with: { account: true, contents: true },
    });
    assert.ok(articleSource != null);

    const article = await getArticle(createFedCtx(tx), articleSource);
    const jsonLd = await article.toJsonLd() as {
      nameMap?: Record<string, string>;
    };

    assert.equal(article.name?.toString(), "본문 제목이 아닌 글 제목");
    assert.deepEqual(jsonLd.nameMap, {
      ko: "본문 제목이 아닌 글 제목",
      en: "Article title, not body title",
    });
    assert.match(
      article.content?.toString() ?? "",
      />Article title, not body title<\/a>/,
    );
  });
});

test("getQuestion() advertises the emoji reactions collection", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "questionemojireactions",
      name: "Question Emoji Reactions",
      email: "questionemojireactions@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");
    const question = await createQuestion(
      createFedCtx(tx) as unknown as Context<ContextData<Transaction>>,
      {
        accountId: author.account.id,
        visibility: "public",
        quotePolicy: "everyone",
        content: "React to a poll?",
        language: "en",
        media: [],
        published,
        updated: published,
        poll: {
          title: "Poll reactions",
          multiple: false,
          options: ["Yes", "No"],
          ends: new Date("2026-04-16T00:00:00.000Z"),
          now: published,
        },
      },
    );
    assert.ok(question != null);
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: question.noteSource.id },
      with: {
        account: true,
        media: { with: { medium: true }, orderBy: { index: "asc" } },
      },
    });
    const poll = await tx.query.pollTable.findFirst({
      where: { postId: question.id },
      with: { options: { orderBy: { index: "asc" } } },
    });
    assert.ok(noteSource != null);
    assert.ok(poll != null);

    const activity = await getQuestion(createFedCtx(tx), noteSource, {
      ...poll,
      post: question,
    });

    assert.equal(
      activity.emojiReactionsId?.href,
      `http://localhost/ap/emoji-reactions/questions/${question.noteSource.id}`,
    );
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

test("isEmojiReactionCollectionVisible() preserves signed actor block checks", () => {
  const viewer = { iri: "https://viewer.example/actors/blocked" };
  const author = {
    iri: "https://author.example/actors/author",
    followers: [],
    blockees: [{
      blockeeId: "00000000-0000-0000-0000-000000000001",
      blockee: viewer,
    }],
    blockers: [],
  };
  const post = {
    visibility: "public",
    actor: author,
    mentions: [],
  } as unknown as Parameters<typeof isEmojiReactionCollectionVisible>[1];

  assert.equal(isEmojiReactionCollectionVisible("note", post), true);
  assert.equal(isEmojiReactionCollectionVisible("note", post, viewer), false);
  assert.equal(
    isEmojiReactionCollectionVisible("question", post, viewer),
    false,
  );
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
