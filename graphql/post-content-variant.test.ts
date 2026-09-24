import assert from "node:assert";
import test from "node:test";
import {
  Article,
  LanguageString,
  PUBLIC_COLLECTION,
  Translation,
} from "@fedify/vocab";
import {
  createArticle,
  publishArticleTranslation,
} from "@hackerspub/models/article";
import { getCurrentSourceRevision } from "@hackerspub/models/article-revision";
import { saveArticleTranslationDraft } from "@hackerspub/models/article-translation";
import { persistPost } from "@hackerspub/models/post/remote";
import { postTable } from "@hackerspub/models/schema";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const variantQuery = parse(`
  query PostContentVariants($id: ID!, $language: Locale) {
    node(id: $id) {
      ... on Post {
        contentVariant(language: $language) {
          language
          url
          name
          summary
          excerpt
          content
          translation {
            kind
            freshness
            byAuthor
            publisherAsserted
            translatorIris
            translators {
              handle
            }
          }
        }
        contentVariants {
          language
          default
        }
      }
    }
  }
`);

interface VariantResult {
  contentVariant: {
    language: string | null;
    url: string;
    name: string | null;
    summary: string | null;
    excerpt: string;
    content: string;
    translation: {
      kind: string;
      freshness: string;
      byAuthor: boolean;
      publisherAsserted: boolean;
      translatorIris: string[];
      translators: { handle: string }[];
    } | null;
  };
  contentVariants: { language: string | null; default: boolean }[];
}

async function readVariants(
  contextValue: unknown,
  id: string,
  language?: string,
): Promise<VariantResult> {
  const result = await execute({
    schema,
    document: variantQuery,
    variableValues: { id, language },
    contextValue: contextValue as never,
    onError: "NO_PROPAGATE",
  });
  assert.deepEqual(result.errors, undefined);
  const node = (result.data as { node: VariantResult | null }).node;
  assert.ok(node != null);
  return node;
}

test("a remote article's variants expose the publisher's translation claims", async () => {
  await withRollback(async (tx) => {
    const author = await insertRemoteActor(tx, {
      username: "gqlvariantauthor",
      name: "Variant Author",
      host: "remote.example",
    });
    const translator = await insertRemoteActor(tx, {
      username: "gqlvarianttranslator",
      name: "Translator",
      host: "remote.example",
    });
    const id = new URL("https://remote.example/articles/gql");
    const post = await persistPost(
      createFedCtx(tx),
      new Article({
        id,
        attribution: new URL(author.iri),
        to: PUBLIC_COLLECTION,
        names: [
          new LanguageString("Original", "en"),
          new LanguageString("번역", "ko"),
        ],
        contents: [
          new LanguageString("<p>Original</p>", "en"),
          new LanguageString(
            '<p>번역 본문</p><img src="x" onerror="alert(1)">',
            "ko",
          ),
        ],
        summaries: [
          new LanguageString("Summary", "en"),
          new LanguageString('<img src="x" onerror="alert(1)">요약', "ko"),
        ],
        translations: [
          new Translation({
            language: new Intl.Locale("ko"),
            translators: [new URL(translator.iri)],
            original: id,
            sourceUpdated: Temporal.Instant.from("2026-09-01T00:00:00Z"),
          }),
        ],
        published: Temporal.Instant.from("2026-09-01T00:00:00Z"),
      }),
      { fetchRemote: false },
    );
    assert.ok(post != null);
    const globalId = encodeGlobalID("Article", post.id);
    const guest = makeGuestContext(tx);

    const korean = await readVariants(guest, globalId, "ko-KR");
    assert.equal(korean.contentVariant.language, "ko");
    assert.equal(korean.contentVariant.name, "번역");
    // Remote HTML in a language alternative is sanitized like any other.
    assert.ok(!korean.contentVariant.content.includes("onerror"));
    assert.ok(!korean.contentVariant.summary?.includes("onerror"));
    assert.ok(korean.contentVariant.summary?.includes("요약"));
    // `excerpt` is plain text even when the summary carries markup.
    assert.equal(korean.contentVariant.excerpt, "요약");
    assert.deepEqual(korean.contentVariant.translation, {
      kind: "HUMAN",
      freshness: "CURRENT",
      byAuthor: false,
      publisherAsserted: true,
      translatorIris: [translator.iri],
      translators: [{ handle: "@gqlvarianttranslator@remote.example" }],
    });
    // A language nobody published falls back to the default variant.
    const french = await readVariants(guest, globalId, "fr");
    assert.equal(french.contentVariant.language, "en");
    assert.equal(french.contentVariant.translation, null);
    assert.deepEqual(korean.contentVariants, [
      { language: "en", default: true },
      { language: "ko", default: false },
    ]);

    // Censorship empties the content and hides the credit, like
    // `Post.content`.
    await tx
      .update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, post.id));
    const censored = await readVariants(guest, globalId, "ko");
    assert.equal(censored.contentVariant.content, "");
    assert.equal(censored.contentVariant.name, null);
    assert.equal(censored.contentVariant.translation, null);
    // The link leads to the local notice, not the uncensored origin.
    assert.equal(
      censored.contentVariant.url,
      `http://localhost/@gqlvariantauthor@remote.example/${post.id}`,
    );
  });
});

test("a local article's variants mirror its published language versions", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = {
      summarizer: {} as never,
      translator: {} as never,
      moderationAnalyzer: {} as never,
    } as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "gqllocalvariant",
      name: "Local Variant",
      email: "gqllocalvariant@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "local-variants",
      tags: [],
      allowLlmTranslation: false,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const saved = await saveArticleTranslationDraft(tx, author.account, {
      sourceId,
      language: "ja",
      title: "日本語",
      content: "日本語の本文",
    });
    assert.equal(saved.status, "ok");
    if (saved.status !== "ok") return;
    // A private draft is never a variant.
    const globalId = encodeGlobalID("Article", article.id);
    const guest = makeGuestContext(tx);
    assert.deepEqual((await readVariants(guest, globalId)).contentVariants, [
      { language: "en", default: true },
    ]);
    const revision = await getCurrentSourceRevision(tx, sourceId);
    await publishArticleTranslation(fedCtx, author.account, {
      translationDraftId: saved.draft.id,
      revision: saved.draft.revision,
      sourceRevisionId: revision?.id,
    });
    const japanese = await readVariants(guest, globalId, "ja");
    assert.equal(japanese.contentVariant.name, "日本語");
    assert.equal(japanese.contentVariant.translation?.kind, "HUMAN");
    assert.equal(japanese.contentVariant.translation?.freshness, "CURRENT");
    assert.equal(japanese.contentVariant.translation?.byAuthor, true);
    assert.equal(japanese.contentVariant.translation?.publisherAsserted, false);

    // A stored alias key (`tl` canonicalizes to `fil`) is still reachable.
    const tagalog = await saveArticleTranslationDraft(tx, author.account, {
      sourceId,
      language: "tl",
      title: "Tagalog",
      content: "Katawan",
    });
    assert.equal(tagalog.status, "ok");
    if (tagalog.status !== "ok") return;
    await publishArticleTranslation(fedCtx, author.account, {
      translationDraftId: tagalog.draft.id,
      revision: tagalog.draft.revision,
      sourceRevisionId: revision?.id,
    });
    const tl = await readVariants(guest, globalId, "tl");
    assert.equal(tl.contentVariant.name, "Tagalog");
  });
});

test("withdrawArticleTranslation requires editing authority", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = {
      summarizer: {} as never,
      translator: {} as never,
      moderationAnalyzer: {} as never,
    } as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "gqlwithdrawauthor",
      name: "Withdraw Author",
      email: "gqlwithdrawauthor@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "gqlwithdrawstranger",
      name: "Stranger",
      email: "gqlwithdrawstranger@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "withdraw-authority",
      tags: [],
      allowLlmTranslation: false,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const saved = await saveArticleTranslationDraft(tx, author.account, {
      sourceId,
      language: "ko",
      title: "번역",
      content: "번역 본문",
    });
    assert.equal(saved.status, "ok");
    if (saved.status !== "ok") return;
    await publishArticleTranslation(fedCtx, author.account, {
      translationDraftId: saved.draft.id,
      revision: saved.draft.revision,
    });
    const mutation = parse(`
      mutation Withdraw($sourceId: UUID!, $language: Locale!) {
        withdrawArticleTranslation(
          input: { sourceId: $sourceId, language: $language }
        ) {
          __typename
          ... on WithdrawArticleTranslationPayload {
            language
            translationDraft {
              publicationState
            }
          }
        }
      }
    `);
    const run = async (account: typeof author.account) => {
      const viewer = await tx.query.accountTable.findFirst({
        where: { id: account.id },
        with: { actor: true },
      });
      assert.ok(viewer != null);
      const result = await execute({
        schema,
        document: mutation,
        variableValues: { sourceId, language: "ko" },
        contextValue: makeUserContext(tx, viewer as never, {
          fedCtx,
        }) as never,
        onError: "NO_PROPAGATE",
      });
      assert.deepEqual(result.errors, undefined);
      return (result.data as { withdrawArticleTranslation: unknown })
        .withdrawArticleTranslation as {
        __typename: string;
        language?: string;
        translationDraft?: { publicationState: string } | null;
      };
    };
    const denied = await run(stranger.account);
    assert.equal(denied.__typename, "OrganizationPermissionError");
    const allowed = await run(author.account);
    assert.equal(allowed.__typename, "WithdrawArticleTranslationPayload");
    assert.equal(allowed.language, "ko");
    assert.equal(allowed.translationDraft?.publicationState, "UNPUBLISHED");
  });
});
