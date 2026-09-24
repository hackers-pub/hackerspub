// FEP-22cd ingest, pinned to the draft revision Fedify 2.4.0-dev.1988
// targets:
// https://codeberg.org/fediverse/fep/src/commit/6d0d6559054baeb7b71a5f2bdc14fc4c09b66f39/fep/22cd/fep-22cd.md
//
// These are offline fixtures and a local sender/receiver round trip; they say
// nothing about how other fediverse software renders the metadata.
import assert from "node:assert";
import test from "node:test";
import {
  Article,
  LanguageString,
  PUBLIC_COLLECTION,
  Translation,
} from "@fedify/vocab";
import { createArticle, publishArticleTranslation } from "./article.ts";
import { getCurrentSourceRevision } from "./article-revision.ts";
import { saveArticleTranslationDraft } from "./article-translation.ts";
import { buildRemoteContentVariants } from "./post/content-variant.ts";
import { persistPost } from "./post/remote.ts";
import type { Transaction } from "./db.ts";
import { organizationMembershipTable } from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

const REMOTE = "https://remote.example";

function remoteArticle(values: {
  id?: string;
  author: string;
  updated?: string;
  contents: (string | LanguageString)[];
  names?: (string | LanguageString)[];
  translations?: Translation[];
}): Article {
  const published = Temporal.Instant.from("2026-09-01T00:00:00Z");
  return new Article({
    id: new URL(values.id ?? `${REMOTE}/articles/1`),
    attribution: new URL(values.author),
    to: PUBLIC_COLLECTION,
    names: values.names ?? ["Title"],
    contents: values.contents,
    translations: values.translations ?? [],
    published,
    updated:
      values.updated == null ? null : Temporal.Instant.from(values.updated),
  });
}

async function variantsOf(tx: Transaction, iri: string) {
  const post = await tx.query.postTable.findFirst({
    where: { iri },
    with: { contentVariants: true },
  });
  assert.ok(post != null);
  return new Map(post.contentVariants.map((v) => [v.language, v]));
}

test("buildRemoteContentVariants() follows the language-map rules", () => {
  // An untagged default identical to a tagged value marks it as default.
  const same = buildRemoteContentVariants(
    remoteArticle({
      author: `${REMOTE}/users/a`,
      contents: [
        "<p>Hello</p>",
        new LanguageString("<p>Hello</p>", "en"),
        new LanguageString("<p>안녕</p>", "ko"),
      ],
      names: [
        "Hi",
        new LanguageString("Hi", "en"),
        new LanguageString("제목", "ko"),
        new LanguageString("Titre", "fr"),
      ],
    }),
  );
  assert.deepEqual(
    same.map((v) => [v.language, v.default, v.name]),
    [
      ["en", true, "Hi"],
      ["ko", false, "제목"],
    ],
  );
  // An untagged summary belongs to the default variant it describes.
  const plainSummary = buildRemoteContentVariants(
    new Article({
      id: new URL(`${REMOTE}/articles/summary`),
      attribution: new URL(`${REMOTE}/users/a`),
      name: "Title",
      summary: "Plain summary",
      contents: ["<p>Hello</p>", new LanguageString("<p>Hello</p>", "en")],
    }),
  );
  assert.deepEqual(
    plainSummary.map((v) => [v.language, v.default, v.name, v.summary]),
    [["en", true, "Title", "Plain summary"]],
  );
  // A different untagged default is stored on its own, without a language.
  const different = buildRemoteContentVariants(
    remoteArticle({
      author: `${REMOTE}/users/a`,
      contents: [
        "<nav>…</nav><p>Hello</p>",
        new LanguageString("<p>Hello</p>", "en"),
      ],
    }),
  );
  assert.deepEqual(
    different.map((v) => [v.language, v.default]),
    [
      [null, true],
      ["en", false],
    ],
  );
  // No language-tagged content means no variants at all.
  assert.deepEqual(
    buildRemoteContentVariants(
      remoteArticle({ author: `${REMOTE}/users/a`, contents: ["<p>Hi</p>"] }),
    ),
    [],
  );
});

test("a Hackers' Pub article round-trips its translation metadata", async () => {
  await withRollback(async (tx) => {
    // Sender: a local organization article with two translators.
    const fedCtx = createFedCtx(tx);
    fedCtx.models = {
      summarizer: {} as never,
      translator: {} as never,
      moderationAnalyzer: {} as never,
    } as typeof fedCtx.models;
    const org = await insertAccountWithActor(tx, {
      username: "rtorg",
      name: "Round Trip Org",
      email: "rtorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const bob = await insertAccountWithActor(tx, {
      username: "rtbob",
      name: "Bob",
      email: "rtbob@example.com",
    });
    const carol = await insertAccountWithActor(tx, {
      username: "rtcarol",
      name: "Carol",
      email: "rtcarol@example.com",
    });
    for (const member of [bob, carol]) {
      await tx.insert(organizationMembershipTable).values({
        organizationAccountId: org.account.id,
        memberAccountId: member.account.id,
        role: "member",
        invitedById: member.account.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
    }
    const article = await createArticle(fedCtx, {
      accountId: org.account.id,
      publishedYear: 2026,
      slug: "round-trip",
      tags: [],
      allowLlmTranslation: false,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    for (const [translator, language] of [
      [bob, "ja"],
      [carol, "ko"],
    ] as const) {
      const saved = await saveArticleTranslationDraft(tx, bob.account, {
        sourceId,
        language,
        title: `${language} title`,
        content: `${language} body`,
        translatorId: translator.account.id,
      });
      assert.equal(saved.status, "ok");
      if (saved.status !== "ok") return;
      const revision = await getCurrentSourceRevision(tx, sourceId);
      const published = await publishArticleTranslation(fedCtx, bob.account, {
        translationDraftId: saved.draft.id,
        revision: saved.draft.revision,
        sourceRevisionId: revision?.id,
      });
      assert.equal(published.status, "ok");
    }
    const source = await tx.query.articleSourceTable.findFirst({
      where: { id: sourceId },
      with: { account: true, contents: true },
    });
    assert.ok(source != null);
    const sent = await fedCtx.services.federation.getArticle(fedCtx, source);
    // Receiver: the same document as another server would see it.
    const json = JSON.stringify(await sent.toJsonLd()).replaceAll(
      "http://localhost/",
      `${REMOTE}/`,
    );
    const received = await Article.fromJsonLd(JSON.parse(json), {
      documentLoader: fedCtx.documentLoader,
      contextLoader: fedCtx.contextLoader,
    });
    await insertRemoteActor(tx, {
      username: "rtorg",
      name: "Round Trip Org",
      host: "remote.example",
      iri: `${REMOTE}/actors/${org.account.id}`,
      type: "Organization",
    });
    await insertRemoteActor(tx, {
      username: "rtbob",
      name: "Bob",
      host: "remote.example",
      iri: `${REMOTE}/actors/${bob.account.id}`,
    });
    // Carol's actor is unknown to the receiver.
    const persisted = await persistPost(fedCtx, received, {
      fetchRemote: false,
    });
    assert.ok(persisted != null);
    const variants = await variantsOf(tx, received.id!.href);
    // The nav fallback differs from every tagged value, so it is kept apart.
    assert.equal(variants.get(null)?.default, true);
    assert.equal(variants.get("en")?.translationKind, null);
    assert.equal(variants.get("ja")?.translationKind, "human");
    assert.equal(variants.get("ja")?.freshness, "current");
    assert.deepEqual(variants.get("ja")?.translatorIris, [
      `${REMOTE}/actors/${bob.account.id}`,
    ]);
    assert.equal(
      variants.get("ja")?.url,
      `${REMOTE}/@rtorg/2026/round-trip/ja`,
    );
    // An unresolvable translator makes the classification unknown rather
    // than a guess from the actors that could be resolved.
    assert.equal(variants.get("ko")?.translationKind, "unknown");
    assert.ok(variants.get("ko")?.contentHtml.includes("ko body"));
  });
});

test("Updates replace variants wholesale, and older or foreign ones are ignored", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertRemoteActor(tx, {
      username: "variantauthor",
      name: "Variant Author",
      host: "remote.example",
    });
    const other = await insertRemoteActor(tx, {
      username: "variantother",
      name: "Other",
      host: "remote.example",
    });
    const translator = await insertRemoteActor(tx, {
      username: "varianttranslator",
      name: "Translator",
      host: "remote.example",
    });
    const machine = await insertRemoteActor(tx, {
      username: "variantbot",
      name: "Bot",
      host: "remote.example",
      type: "Application",
    });
    const id = new URL(`${REMOTE}/articles/1`);
    const entry = (
      language: string,
      translators: string[],
      sourceUpdated?: string,
    ) =>
      new Translation({
        language: new Intl.Locale(language),
        translators: translators.map((iri) => new URL(iri)),
        original: id,
        sourceUpdated:
          sourceUpdated == null ? null : Temporal.Instant.from(sourceUpdated),
      });
    const v1 = remoteArticle({
      author: author.iri,
      updated: "2026-09-10T00:00:00Z",
      contents: [
        new LanguageString("<p>Original</p>", "en"),
        new LanguageString("<p>日本語</p>", "ja"),
        new LanguageString("<p>한국어</p>", "ko"),
      ],
      translations: [
        entry("ja", [translator.iri], "2026-09-05T00:00:00Z"),
        entry("ko", [machine.iri, translator.iri]),
      ],
    });
    await persistPost(fedCtx, v1, { fetchRemote: false });
    let variants = await variantsOf(tx, id.href);
    assert.equal(variants.get("en")?.default, true);
    assert.equal(variants.get("ja")?.translationKind, "human");
    // Reviewed before the source's latest edit.
    assert.equal(variants.get("ja")?.freshness, "source_changed");
    assert.equal(variants.get("ko")?.translationKind, "machine_reviewed");
    // No `sourceUpdated` means no freshness claim.
    assert.equal(variants.get("ko")?.freshness, "unknown");

    // An older, delayed Update is ignored entirely.
    await persistPost(
      fedCtx,
      remoteArticle({
        author: author.iri,
        updated: "2026-09-09T00:00:00Z",
        contents: [new LanguageString("<p>Stale</p>", "en")],
      }),
      { fetchRemote: false },
    );
    variants = await variantsOf(tx, id.href);
    assert.equal(variants.size, 3);

    // So is one attributed to someone else, even from the same server.
    await persistPost(
      fedCtx,
      remoteArticle({
        author: other.iri,
        updated: "2026-09-20T00:00:00Z",
        contents: [new LanguageString("<p>Hijack</p>", "en")],
      }),
      { fetchRemote: false },
    );
    variants = await variantsOf(tx, id.href);
    assert.equal(variants.size, 3);
    assert.equal(variants.get("en")?.contentHtml, "<p>Original</p>");

    // A newer Update that drops `ko` withdraws it, and one that drops the
    // `translations` property removes the metadata but keeps the content.
    await persistPost(
      fedCtx,
      remoteArticle({
        author: author.iri,
        updated: "2026-09-15T00:00:00Z",
        contents: [
          new LanguageString("<p>Original</p>", "en"),
          new LanguageString("<p>日本語</p>", "ja"),
        ],
      }),
      { fetchRemote: false },
    );
    variants = await variantsOf(tx, id.href);
    assert.deepEqual([...variants.keys()].sort(), ["en", "ja"]);
    assert.equal(variants.get("ja")?.translationKind, null);
    assert.equal(variants.get("ja")?.freshness, null);
  });
});

test("malformed translation metadata is dropped without losing content", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertRemoteActor(tx, {
      username: "malformedauthor",
      name: "Malformed Author",
      host: "remote.example",
    });
    const id = new URL(`${REMOTE}/articles/malformed`);
    const article = remoteArticle({
      id: id.href,
      author: author.iri,
      contents: [
        new LanguageString("<p>Original</p>", "en"),
        new LanguageString("<p>日本語</p>", "ja"),
        new LanguageString("<p>한국어</p>", "ko"),
      ],
      translations: [
        // Points at a different object.
        new Translation({
          language: new Intl.Locale("ja"),
          translators: [new URL(author.iri)],
          original: new URL(`${REMOTE}/articles/other`),
        }),
        // Ambiguous: two entries for one language.
        new Translation({
          language: new Intl.Locale("ko"),
          translators: [new URL(author.iri)],
          original: id,
        }),
        new Translation({
          language: new Intl.Locale("ko"),
          translators: [new URL(author.iri)],
          original: id,
        }),
        // A language with no content.
        new Translation({
          language: new Intl.Locale("fr"),
          translators: [new URL(author.iri)],
          original: id,
        }),
      ],
    });
    const persisted = await persistPost(fedCtx, article, {
      fetchRemote: false,
    });
    assert.ok(persisted != null);
    const variants = await variantsOf(tx, id.href);
    assert.deepEqual([...variants.keys()].sort(), ["en", "ja", "ko"]);
    for (const variant of variants.values()) {
      assert.equal(variant.translationKind, null);
    }
  });
});

test("dropped translator IRIs keep the classification unknown", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertRemoteActor(tx, {
      username: "droppedauthor",
      name: "Dropped Author",
      host: "remote.example",
    });
    const id = new URL(`${REMOTE}/articles/dropped`);
    const article = remoteArticle({
      id: id.href,
      author: author.iri,
      contents: [
        new LanguageString("<p>Original</p>", "en"),
        new LanguageString("<p>한국어</p>", "ko"),
      ],
      translations: [
        new Translation({
          language: new Intl.Locale("ko"),
          // A known person plus an IRI with an unsupported scheme, which is
          // dropped before classification.
          translators: [new URL(author.iri), new URL("urn:example:bot")],
          original: id,
          // Readers follow this as a link, so it must never be stored.
          url: new URL("javascript:alert(1)"),
        }),
      ],
    });
    await persistPost(fedCtx, article, { fetchRemote: false });
    const variants = await variantsOf(tx, id.href);
    assert.equal(variants.get("ko")?.translationKind, "unknown");
    assert.deepEqual(variants.get("ko")?.translatorIris, [author.iri]);
    assert.equal(variants.get("ko")?.url, null);
  });
});
