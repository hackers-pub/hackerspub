import assert from "node:assert/strict";
import test from "node:test";
import { Create, Note as ActivityPubNote, QuoteRequest } from "@fedify/vocab";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import type { UserContext } from "./builder.ts";
import { createArticle, updateArticleDraft } from "@hackerspub/models/article";
import {
  accountTable,
  articleContentTable,
  articleDraftTable,
  articleSourceTable,
  followingTable,
  mediumTable,
  type NewPost,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7, type Uuid } from "@hackerspub/models/uuid";
import {
  createMediumUploadSession,
  getMediumUploadSession,
} from "./medium-upload.ts";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  createTestDisk,
  createTestKv,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const saveArticleDraftMutation = parse(`
  mutation SaveArticleDraft($input: SaveArticleDraftInput!) {
    saveArticleDraft(input: $input) {
      __typename
      ... on SaveArticleDraftPayload {
        draft {
          id
          uuid
          title
          tags
        }
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`);

const articleDraftQuery = parse(`
  query ArticleDraft($uuid: UUID!) {
    articleDraft(uuid: $uuid) {
      id
      uuid
      title
      tags
    }
  }
`);

const deleteArticleDraftMutation = parse(`
  mutation DeleteArticleDraft($id: ID!) {
    deleteArticleDraft(input: { id: $id }) {
      __typename
      ... on DeleteArticleDraftPayload {
        deletedDraftId
      }
    }
  }
`);

const publishArticleDraftMutation = parse(`
  mutation PublishArticleDraft($input: PublishArticleDraftInput!) {
    publishArticleDraft(input: $input) {
      __typename
      ... on PublishArticleDraftPayload {
        article {
          id
          slug
        }
        deletedDraftId
      }
    }
  }
`);

const articleByYearAndSlugQuery = parse(`
  query ArticleByYearAndSlug($handle: String!, $idOrYear: String!, $slug: String!) {
    articleByYearAndSlug(handle: $handle, idOrYear: $idOrYear, slug: $slug) {
      id
      slug
    }
  }
`);

const articleContentOgImageUrlQuery = parse(`
  query ArticleContentOgImageUrl(
    $handle: String!
    $idOrYear: String!
    $slug: String!
    $language: Locale!
  ) {
    articleByYearAndSlug(handle: $handle, idOrYear: $idOrYear, slug: $slug) {
      contents(language: $language) {
        language
        ogImageUrl
      }
    }
  }
`);

const articleContentOgImageBulkQuery = parse(`
  query ArticleContentOgImageBulk($handle: String!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      articles(first: 20) {
        edges {
          node {
            contents {
              ogImageUrl
            }
          }
        }
      }
    }
  }
`);

const articleContentOgImageBulkByLanguageQuery = parse(`
  query ArticleContentOgImageBulkByLanguage($handle: String!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      articles(first: 20) {
        edges {
          node {
            contents(language: "en") {
              ogImageUrl
            }
          }
        }
      }
    }
  }
`);

const createMediumMutation = parse(`
  mutation CreateMedium($input: CreateMediumInput!) {
    createMedium(input: $input) {
      __typename
      ... on CreateMediumPayload {
        medium {
          uuid
          url
          type
          contentHash
          width
          height
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`);

const mediumContentHashTypeQuery = parse(`
  query MediumContentHashType {
    medium: __type(name: "Medium") {
      fields {
        name
        type {
          kind
          name
          ofType {
            kind
            name
          }
        }
      }
    }
    sha256: __type(name: "Sha256") {
      kind
      name
      description
    }
  }
`);

const attachArticleDraftMediumMutation = parse(`
  mutation AttachArticleDraftMedium($input: AttachArticleDraftMediumInput!) {
    attachArticleDraftMedium(input: $input) {
      __typename
      ... on AttachArticleDraftMediumPayload {
        key
        medium {
          uuid
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`);

const updateArticleWithMediaMutation = parse(`
  mutation UpdateArticleWithMedia($input: UpdateArticleInput!) {
    updateArticle(input: $input) {
      __typename
      ... on UpdateArticlePayload {
        article {
          id
          content
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`);

const finishMediumUploadMutation = parse(`
  mutation FinishMediumUpload($input: FinishMediumUploadInput!) {
    finishMediumUpload(input: $input) {
      __typename
      ... on FinishMediumUploadPayload {
        medium {
          uuid
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`);

const articleContentOgImageCollisionQuery = parse(`
  query ArticleContentOgImageCollision(
    $handle: String!
    $idOrYear: String!
    $firstSlug: String!
    $secondSlug: String!
  ) {
    first: articleByYearAndSlug(handle: $handle, idOrYear: $idOrYear, slug: $firstSlug) {
      contents(language: "en") {
        ogImageUrl
      }
    }
    second: articleByYearAndSlug(handle: $handle, idOrYear: $idOrYear, slug: $secondSlug) {
      contents(language: "en") {
        ogImageUrl
      }
    }
  }
`);

const createNoteMutation = parse(`
  mutation CreateNote($input: CreateNoteInput!) {
    createNote(input: $input) {
      __typename
      ... on CreateNotePayload {
        note {
          id
          excerpt
        }
      }
    }
  }
`);

const createNoteWithErrorMutation = parse(`
  mutation CreateNoteWithError($input: CreateNoteInput!) {
    createNote(input: $input) {
      __typename
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`);

const viewerCanRevokeQuoteQuery = parse(`
  query ViewerCanRevokeQuote($id: ID!) {
    node(id: $id) {
      ... on Post {
        viewerCanRevokeQuote
      }
    }
  }
`);

const revokeQuoteMutation = parse(`
  mutation RevokeQuote($input: RevokeQuoteInput!) {
    revokeQuote(input: $input) {
      __typename
      ... on RevokeQuotePayload {
        quote {
          id
        }
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`);

const sharePostMutation = parse(`
  mutation SharePost($postId: ID!) {
    sharePost(input: { postId: $postId }) {
      __typename
      ... on SharePostPayload {
        originalPost {
          id
        }
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`);

const deletePostMutation = parse(`
  mutation DeletePost($id: ID!) {
    deletePost(input: { id: $id }) {
      __typename
      ... on DeletePostPayload {
        deletedPostId
      }
      ... on SharedPostDeletionNotAllowedError {
        inputPath
      }
    }
  }
`);

const postByUrlQuery = parse(`
  query PostByUrl($url: String!) {
    postByUrl(url: $url) {
      id
    }
  }
`);

const smallPngDataUrl = "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function createOgTestDisk(): {
  disk: UserContext["disk"];
  putKeys: string[];
  deleteKeys: string[];
} {
  const putKeys: string[] = [];
  const deleteKeys: string[] = [];
  return {
    putKeys,
    deleteKeys,
    disk: {
      getUrl(key: string) {
        if (key === "article-avatar-og-test") {
          return Promise.resolve(smallPngDataUrl);
        }
        return Promise.resolve(`http://localhost/media/${key}`);
      },
      put(key: string) {
        putKeys.push(key);
        return Promise.resolve(undefined);
      },
      delete(key: string) {
        deleteKeys.push(key);
        return Promise.resolve(undefined);
      },
    } as unknown as UserContext["disk"],
  };
}

function makeTransactionalUserContext(
  tx: Parameters<typeof withRollback>[0] extends (tx: infer T) => Promise<void>
    ? T
    : never,
  account: Parameters<typeof makeUserContext>[1],
  fedCtxOverrides: Partial<UserContext["fedCtx"]> = {},
): UserContext {
  const baseFedCtx = { ...createFedCtx(tx), ...fedCtxOverrides };
  const fedCtx = {
    ...baseFedCtx,
    request: new Request("http://localhost/graphql"),
    federation: {
      createContext(request: unknown, data: unknown) {
        return {
          ...baseFedCtx,
          request,
          data,
        };
      },
    },
  } as UserContext["fedCtx"];
  return makeUserContext(tx, account, { fedCtx });
}

test("saveArticleDraft, articleDraft, and deleteArticleDraft round-trip a draft", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "draftgraphql",
      name: "Draft GraphQL",
      email: "draftgraphql@example.com",
    });

    const saveResult = await execute({
      schema,
      document: saveArticleDraftMutation,
      variableValues: {
        input: {
          title: "Draft title",
          content: "Draft body",
          tags: ["relay", "relay", "solid"],
        },
      },
      contextValue: makeTransactionalUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(saveResult.errors, undefined);
    const savedDraft = (toPlainJson(saveResult.data) as {
      saveArticleDraft: {
        __typename: string;
        draft: { id: string; uuid: string; title: string; tags: string[] };
      };
    }).saveArticleDraft.draft;

    assert.equal(savedDraft.title, "Draft title");
    assert.deepEqual(savedDraft.tags, ["relay", "solid"]);

    const draftQueryResult = await execute({
      schema,
      document: articleDraftQuery,
      variableValues: { uuid: savedDraft.uuid },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(draftQueryResult.errors, undefined);
    assert.deepEqual(toPlainJson(draftQueryResult.data), {
      articleDraft: {
        id: encodeGlobalID("ArticleDraft", savedDraft.uuid),
        uuid: savedDraft.uuid,
        title: "Draft title",
        tags: ["relay", "solid"],
      },
    });

    const deleteResult = await execute({
      schema,
      document: deleteArticleDraftMutation,
      variableValues: {
        id: encodeGlobalID("ArticleDraft", savedDraft.uuid),
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(deleteResult.errors, undefined);
    assert.deepEqual(toPlainJson(deleteResult.data), {
      deleteArticleDraft: {
        __typename: "DeleteArticleDraftPayload",
        deletedDraftId: encodeGlobalID("ArticleDraft", savedDraft.uuid),
      },
    });

    const storedDraft = await tx.query.articleDraftTable.findFirst({
      where: {
        id: savedDraft
          .uuid as `${string}-${string}-${string}-${string}-${string}`,
      },
    });
    assert.equal(storedDraft, undefined);
  });
});

test("saveArticleDraft rejects draft UUIDs owned by another account", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "draftuuidowner",
      name: "Draft UUID Owner",
      email: "draftuuidowner@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "draftuuidother",
      name: "Draft UUID Other",
      email: "draftuuidother@example.com",
    });
    const draftId = generateUuidV7();
    await updateArticleDraft(tx, {
      id: draftId,
      accountId: owner.account.id,
      title: "Owned draft",
      content: "Owned content",
      tags: [],
    });

    const result = await execute({
      schema,
      document: saveArticleDraftMutation,
      variableValues: {
        input: {
          uuid: draftId,
          title: "Conflicting draft",
          content: "Conflicting content",
          tags: [],
        },
      },
      contextValue: makeUserContext(tx, other.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      saveArticleDraft: {
        __typename: "InvalidInputError",
        inputPath: "uuid",
      },
    });
  });
});

test("Medium.contentHash is exposed as Sha256", async () => {
  const result = await execute({
    schema,
    document: mediumContentHashTypeQuery,
    onError: "NO_PROPAGATE",
  });

  assert.equal(result.errors, undefined);
  const data = toPlainJson(result.data) as {
    medium: {
      fields: {
        name: string;
        type: {
          kind: string;
          name: string | null;
          ofType: { kind: string; name: string | null } | null;
        };
      }[];
    };
    sha256: {
      kind: string;
      name: string;
      description: string;
    };
  };
  assert.equal(data.sha256.kind, "SCALAR");
  assert.equal(data.sha256.name, "Sha256");
  assert.match(data.sha256.description, /SHA-256/);
  const contentHash = data.medium.fields.find((field) =>
    field.name === "contentHash"
  );
  assert.deepEqual(contentHash?.type, {
    kind: "SCALAR",
    name: "Sha256",
    ofType: null,
  });
});

test("createMedium and attachArticleDraftMedium create draft media relations", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "mediumgraphql",
      name: "Medium GraphQL",
      email: "mediumgraphql@example.com",
    });
    const disk = createOgTestDisk();

    const createResult = await execute({
      schema,
      document: createMediumMutation,
      variableValues: { input: { url: smallPngDataUrl } },
      contextValue: makeUserContext(tx, account.account, { disk: disk.disk }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(createResult.errors, undefined);
    const medium = (toPlainJson(createResult.data) as {
      createMedium: {
        __typename: string;
        medium: {
          uuid: string;
          url: string;
          type: string;
          contentHash: string;
          width: number;
          height: number;
        };
      };
    }).createMedium.medium;
    assert.equal(medium.type, "image/webp");
    assert.match(medium.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(medium.width, 1);
    assert.equal(medium.height, 1);
    assert.match(medium.url, /^http:\/\/localhost\/media\/media\/.+\.webp$/);
    assert.equal(disk.putKeys.length, 1);

    const draftId = generateUuidV7();
    const attachResult = await execute({
      schema,
      document: attachArticleDraftMediumMutation,
      variableValues: {
        input: {
          draftId,
          mediumId: medium.uuid,
        },
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(attachResult.errors, undefined);
    const attached = (toPlainJson(attachResult.data) as {
      attachArticleDraftMedium: {
        __typename: string;
        key: string;
        medium: { uuid: string };
      };
    }).attachArticleDraftMedium;
    assert.equal(attached.__typename, "AttachArticleDraftMediumPayload");
    assert.equal(attached.key, medium.uuid);
    assert.equal(attached.medium.uuid, medium.uuid);

    const relation = await tx.query.articleDraftMediumTable.findFirst({
      where: { articleDraftId: draftId },
    });
    assert.equal(relation?.mediumId, medium.uuid);
    assert.equal(relation?.key, medium.uuid);
    const draft = await tx.query.articleDraftTable.findFirst({
      where: { id: draftId },
    });
    assert.equal(draft?.title, "");
    assert.equal(draft?.content, "");
  });
});

test("updateArticle accepts media for new article source references", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "updatearticlemediumgraphql",
      name: "Update Article Medium GraphQL",
      email: "updatearticlemediumgraphql@example.com",
    });
    const fedCtx = createFedCtx(tx);
    const article = await createArticle(fedCtx, {
      accountId: account.account.id,
      publishedYear: 2026,
      slug: "update-article-medium-graphql",
      tags: [],
      allowLlmTranslation: false,
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
      title: "Original article",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const mediumId = generateUuidV7();
    await tx.insert(mediumTable).values({
      id: mediumId,
      key: "media/update-article-medium-graphql.webp",
      type: "image/webp",
      width: 2,
      height: 2,
    });

    const result = await execute({
      schema,
      document: updateArticleWithMediaMutation,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", article.id),
          content: "![Hero](hp-medium:hero)",
          media: [{ key: "hero", mediumId }],
        },
      },
      contextValue: makeUserContext(tx, account.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const updated = (toPlainJson(result.data) as {
      updateArticle: {
        __typename: string;
        article: { content: string };
      };
    }).updateArticle;
    assert.equal(updated.__typename, "UpdateArticlePayload");
    assert.match(
      updated.article.content,
      /http:\/\/localhost\/media\/media\/update-article-medium-graphql\.webp/,
    );
    assert.doesNotMatch(updated.article.content, /hp-medium:hero/);

    const relation = await tx.query.articleSourceMediumTable.findFirst({
      where: { articleSourceId: article.articleSource.id, key: "hero" },
    });
    assert.equal(relation?.mediumId, mediumId);
  });
});

test("finishMediumUpload cleans up invalid uploaded bytes", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "invaliduploadgraphql",
      name: "Invalid Upload GraphQL",
      email: "invaliduploadgraphql@example.com",
    });
    const { kv } = createTestKv();
    const disk = createTestDisk();
    const upload = await createMediumUploadSession(
      kv,
      account.account.id,
      "image/png",
      4,
    );
    await disk.put(upload.key, new Uint8Array([1, 2, 3, 4]));

    const result = await execute({
      schema,
      document: finishMediumUploadMutation,
      variableValues: { input: { uploadId: upload.id } },
      contextValue: makeUserContext(tx, account.account, { kv, disk }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      finishMediumUpload: {
        __typename: "InvalidInputError",
        inputPath: "uploadId",
      },
    });
    assert.throws(() => disk.getBytes(upload.key));
    assert.equal(await getMediumUploadSession(kv, upload.id), undefined);
  });
});

test("finishMediumUpload rejects unexpected uploaded size before reading", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "mismatcheduploadgraphql",
      name: "Mismatched Upload GraphQL",
      email: "mismatcheduploadgraphql@example.com",
    });
    const { kv } = createTestKv();
    const disk = createTestDisk();
    const upload = await createMediumUploadSession(
      kv,
      account.account.id,
      "image/png",
      4,
    );
    await disk.put(upload.key, new Uint8Array([1, 2, 3, 4, 5]));

    const result = await execute({
      schema,
      document: finishMediumUploadMutation,
      variableValues: { input: { uploadId: upload.id } },
      contextValue: makeUserContext(tx, account.account, { kv, disk }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      finishMediumUpload: {
        __typename: "InvalidInputError",
        inputPath: "uploadId",
      },
    });
    assert.throws(() => disk.getBytes(upload.key));
    assert.equal(await getMediumUploadSession(kv, upload.id), undefined);
  });
});

test("publishArticleDraft publishes an article and removes the draft", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "publishdraftgraphql",
      name: "Publish Draft GraphQL",
      email: "publishdraftgraphql@example.com",
    });
    const draftId = generateUuidV7();
    const timestamp = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleDraftTable).values({
      id: draftId,
      accountId: account.account.id,
      title: "Published article",
      content: "Published **body**",
      tags: ["federation"],
      created: timestamp,
      updated: timestamp,
    });

    const publishResult = await execute({
      schema,
      document: publishArticleDraftMutation,
      variableValues: {
        input: {
          id: encodeGlobalID("ArticleDraft", draftId),
          slug: "published-article",
          language: "en",
          allowLlmTranslation: false,
        },
      },
      contextValue: makeTransactionalUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(publishResult.errors, undefined);
    const payload = (toPlainJson(publishResult.data) as {
      publishArticleDraft: {
        __typename: string;
        article: { id: string; slug: string };
        deletedDraftId: string;
      };
    }).publishArticleDraft;

    assert.equal(payload.article.slug, "published-article");
    assert.equal(
      payload.deletedDraftId,
      encodeGlobalID("ArticleDraft", draftId),
    );

    const articleSource = await tx.query.articleSourceTable.findFirst({
      where: {
        accountId: account.account.id,
        slug: "published-article",
      },
      with: { contents: true },
    });
    assert.ok(articleSource != null);
    assert.equal(articleSource.contents.length, 1);
    assert.equal(articleSource.contents[0].title, "Published article");

    const remainingDraft = await tx.query.articleDraftTable.findFirst({
      where: {
        id: draftId as `${string}-${string}-${string}-${string}-${string}`,
      },
    });
    assert.equal(remainingDraft, undefined);
  });
});

test("ArticleContent.ogImageUrl keys do not collide across articles", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "articleogcollision",
      name: "Article OG Collision",
      email: "articleogcollision@example.com",
    });
    const [avatarMedium] = await tx.insert(mediumTable).values({
      id: generateUuidV7(),
      key: "article-avatar-og-test",
      type: "image/webp",
      width: null,
      height: null,
    }).returning();
    await tx.update(accountTable)
      .set({ avatarMediumId: avatarMedium.id })
      .where(eq(accountTable.id, author.account.id));
    const published = new Date("2026-04-15T00:00:00.000Z");

    const slugs = ["same-preview-a", "same-preview-b"];
    for (const slug of slugs) {
      const sourceId = generateUuidV7();
      const postId = generateUuidV7();
      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug,
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Same Open Graph preview",
        content: "Identical article body for cache key collision coverage.",
        published,
        updated: published,
      });
      await tx.insert(postTable).values(
        {
          id: postId,
          iri: `http://localhost/objects/${postId}`,
          type: "Article",
          visibility: "public",
          actorId: author.actor.id,
          articleSourceId: sourceId,
          name: "Same Open Graph preview",
          contentHtml:
            "<p>Identical article body for cache key collision coverage.</p>",
          language: "en",
          tags: {},
          emojis: {},
          url: `http://localhost/@${author.account.username}/2026/${slug}`,
          published,
          updated: published,
        } satisfies NewPost,
      );
    }

    const result = await execute({
      schema,
      document: articleContentOgImageCollisionQuery,
      variableValues: {
        handle: author.account.username,
        idOrYear: "2026",
        firstSlug: slugs[0],
        secondSlug: slugs[1],
      },
      contextValue: makeUserContext(tx, author.account, {
        disk: createOgTestDisk().disk,
      }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const data = toPlainJson(result.data) as {
      first: { contents: Array<{ ogImageUrl: string }> };
      second: { contents: Array<{ ogImageUrl: string }> };
    };
    assert.notEqual(
      data.first.contents[0].ogImageUrl,
      data.second.contents[0].ogImageUrl,
    );
  });
});

test("ArticleContent.ogImageUrl rejects bulk article list queries", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "articleogbulk",
      name: "Article OG Bulk",
      email: "articleogbulk@example.com",
    });
    const disk = createOgTestDisk();
    const result = await execute({
      schema,
      document: articleContentOgImageBulkQuery,
      variableValues: { handle: author.account.username },
      contextValue: makeGuestContext(tx, { disk: disk.disk }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(toPlainJson(result.data), { actorByHandle: null });
    assert.match(result.errors?.[0]?.message ?? "", /Query exceeds Complexity/);
    assert.deepEqual(disk.putKeys, []);

    const byLanguageResult = await execute({
      schema,
      document: articleContentOgImageBulkByLanguageQuery,
      variableValues: { handle: author.account.username },
      contextValue: makeGuestContext(tx, { disk: disk.disk }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(toPlainJson(byLanguageResult.data), {
      actorByHandle: null,
    });
    assert.match(
      byLanguageResult.errors?.[0]?.message ?? "",
      /Query exceeds Complexity/,
    );
    assert.deepEqual(disk.putKeys, []);
  });
});

test("ArticleContent.ogImageUrl renders per-language article images", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "articleoggraphql",
      name: "Article OG GraphQL",
      email: "articleoggraphql@example.com",
    });
    const [avatarMedium] = await tx.insert(mediumTable).values({
      id: generateUuidV7(),
      key: "article-avatar-og-test",
      type: "image/webp",
      width: null,
      height: null,
    }).returning();
    await tx.update(accountTable)
      .set({ avatarMediumId: avatarMedium.id })
      .where(eq(accountTable.id, author.account.id));
    const sourceId = generateUuidV7();
    const postId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "og-article",
      tags: [],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values([
      {
        sourceId,
        language: "en",
        title: "Open Graph article",
        content: "English body with emoji 😀 and Korean 안녕하세요.",
        ogImageKey: "og/v2/stale-article-en.png",
        published,
        updated: published,
      },
      {
        sourceId,
        language: "ko-KR",
        title: "오픈 그래프 글",
        content: "한국어 본문과 English mixed script, emoji 😀.",
        ogImageKey: "og/v2/stale-article-ko.png",
        published,
        updated: published,
      },
    ]);
    await tx.insert(postTable).values(
      {
        id: postId,
        iri: `http://localhost/objects/${postId}`,
        type: "Article",
        visibility: "public",
        actorId: author.actor.id,
        articleSourceId: sourceId,
        name: "Open Graph article",
        contentHtml: "<p>English body with emoji 😀 and Korean 안녕하세요.</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: `http://localhost/@${author.account.username}/2026/og-article`,
        published,
        updated: published,
      } satisfies NewPost,
    );

    const disk = createOgTestDisk();
    async function executeOgImageQuery(language: string) {
      const result = await execute({
        schema,
        document: articleContentOgImageUrlQuery,
        variableValues: {
          handle: author.account.username,
          idOrYear: "2026",
          slug: "og-article",
          language,
        },
        contextValue: makeUserContext(tx, author.account, { disk: disk.disk }),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      const contents = (toPlainJson(result.data) as {
        articleByYearAndSlug: {
          contents: Array<{ language: string; ogImageUrl: string }>;
        };
      }).articleByYearAndSlug.contents;
      assert.equal(contents.length, 1);
      return contents[0];
    }

    const firstContentsByLanguage = [
      await executeOgImageQuery("en"),
      await executeOgImageQuery("ko-KR"),
    ];
    assert.equal(
      new Set(firstContentsByLanguage.map((c) => c.ogImageUrl)).size,
      2,
    );
    assert.ok(
      firstContentsByLanguage.every((content) =>
        /^http:\/\/localhost\/media\/og\/v2\/.+\.png$/.test(
          content.ogImageUrl,
        )
      ),
    );
    assert.equal(disk.putKeys.length, 2);
    assert.deepEqual(disk.deleteKeys, []);

    const stored = await tx.query.articleContentTable.findMany({
      where: { sourceId },
      orderBy: { language: "asc" },
    });
    assert.equal(stored.length, 2);
    assert.ok(
      stored.every((content) => content.ogImageKey?.startsWith("og/v2/")),
    );

    assert.deepEqual(
      [
        await executeOgImageQuery("en"),
        await executeOgImageQuery("ko-KR"),
      ],
      firstContentsByLanguage,
    );
    assert.equal(disk.putKeys.length, 2);
    assert.deepEqual(disk.deleteKeys, []);
  });
});

test("articleByYearAndSlug returns a local article by route components", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "articlelookupgraphql",
      name: "Article Lookup GraphQL",
      email: "articlelookupgraphql@example.com",
    });
    const sourceId = generateUuidV7();
    const postId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "route-article",
      tags: [],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Route Article",
      content: "Route article body",
      published,
      updated: published,
    });
    await tx.insert(postTable).values(
      {
        id: postId,
        iri: `http://localhost/objects/${postId}`,
        type: "Article",
        visibility: "public",
        actorId: author.actor.id,
        articleSourceId: sourceId,
        name: "Route Article",
        contentHtml: "<p>Route article body</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: `http://localhost/@${author.account.username}/2026/route-article`,
        published,
        updated: published,
      } satisfies NewPost,
    );

    const result = await execute({
      schema,
      document: articleByYearAndSlugQuery,
      variableValues: {
        handle: author.account.username,
        idOrYear: "2026",
        slug: "route-article",
      },
      contextValue: makeUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      articleByYearAndSlug: {
        id: encodeGlobalID("Article", postId),
        slug: "route-article",
      },
    });
  });
});

const articleContentsIncludeBeingTranslatedQuery = parse(`
  query ArticleContentsIncludeBeingTranslated(
    $handle: String!
    $idOrYear: String!
    $slug: String!
    $includeBeingTranslated: Boolean
  ) {
    articleByYearAndSlug(handle: $handle, idOrYear: $idOrYear, slug: $slug) {
      contents(includeBeingTranslated: $includeBeingTranslated) {
        language
        beingTranslated
      }
    }
  }
`);

test("Article.contents includeBeingTranslated:true returns both completed and in-progress rows", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "translationsincludetest",
      name: "Translation Include Test",
      email: "translationsinclude@example.com",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "translationsincluderequester",
      name: "Translation Include Requester",
      email: "translationsincluderequester@example.com",
    });
    const sourceId = generateUuidV7();
    const postId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "include-being-translated",
      tags: [],
      allowLlmTranslation: true,
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values([
      {
        sourceId,
        language: "en",
        title: "Original",
        content: "English original.",
        published,
        updated: published,
      },
      {
        sourceId,
        language: "ko",
        title: "Original (placeholder)",
        content: "English original.",
        originalLanguage: "en",
        translationRequesterId: requester.account.id,
        beingTranslated: true,
        published,
        updated: published,
      },
    ]);
    await tx.insert(postTable).values(
      {
        id: postId,
        iri: `http://localhost/objects/${postId}`,
        type: "Article",
        visibility: "public",
        actorId: author.actor.id,
        articleSourceId: sourceId,
        name: "Original",
        contentHtml: "<p>English original.</p>",
        language: "en",
        tags: {},
        emojis: {},
        url:
          `http://localhost/@${author.account.username}/2026/include-being-translated`,
        published,
        updated: published,
      } satisfies NewPost,
    );

    const variableValues = {
      handle: author.account.username,
      idOrYear: "2026",
      slug: "include-being-translated",
    };

    type ContentRow = { language: string; beingTranslated: boolean };
    type QueryShape = {
      articleByYearAndSlug: { contents: ContentRow[] };
    };

    const completedOnly = await execute({
      schema,
      document: articleContentsIncludeBeingTranslatedQuery,
      variableValues: { ...variableValues, includeBeingTranslated: false },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(completedOnly.errors, undefined);
    const completedContents =
      (toPlainJson(completedOnly.data) as QueryShape).articleByYearAndSlug
        .contents;
    assert.deepEqual(
      completedContents,
      [{ language: "en", beingTranslated: false }],
    );

    const includingInProgress = await execute({
      schema,
      document: articleContentsIncludeBeingTranslatedQuery,
      variableValues: { ...variableValues, includeBeingTranslated: true },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(includingInProgress.errors, undefined);
    const allContents =
      (toPlainJson(includingInProgress.data) as QueryShape).articleByYearAndSlug
        .contents;
    const sorted = [...allContents].sort((a, b) =>
      a.language.localeCompare(b.language)
    );
    assert.deepEqual(sorted, [
      { language: "en", beingTranslated: false },
      { language: "ko", beingTranslated: true },
    ]);
  });
});

test("createNote creates a note for the signed-in account", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "createnotegraphql",
      name: "Create Note GraphQL",
      email: "createnotegraphql@example.com",
    });

    const result = await execute({
      schema,
      document: createNoteMutation,
      variableValues: {
        input: {
          visibility: "PUBLIC",
          content: "Hello from GraphQL createNote",
          language: "en",
        },
      },
      contextValue: makeTransactionalUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const note = (toPlainJson(result.data) as {
      createNote: {
        __typename: string;
        note: { id: string; excerpt: string };
      };
    }).createNote.note;

    assert.equal(note.excerpt, "Hello from GraphQL createNote");

    const createdSources = await tx.query.noteSourceTable.findMany({
      where: {
        accountId: account.account.id,
        content: "Hello from GraphQL createNote",
      },
    });
    assert.equal(createdSources.length, 1);
  });
});

test("createNote rejects invisible reply and quote targets", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "createnoteprivateauthor",
      name: "Create Note Private Author",
      email: "createnoteprivateauthor@example.com",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "createnoteprivaterequester",
      name: "Create Note Private Requester",
      email: "createnoteprivaterequester@example.com",
    });
    const { post: privateTarget } = await insertNotePost(tx, {
      account: author.account,
      visibility: "direct",
      content: "private target",
    });

    const replyResult = await execute({
      schema,
      document: createNoteWithErrorMutation,
      variableValues: {
        input: {
          content: "attempted private reply",
          language: "en",
          visibility: "PUBLIC",
          replyTargetId: encodeGlobalID("Note", privateTarget.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, requester.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(replyResult.errors, undefined);
    assert.deepEqual(toPlainJson(replyResult.data), {
      createNote: {
        __typename: "InvalidInputError",
        inputPath: "replyTargetId",
      },
    });

    const quoteResult = await execute({
      schema,
      document: createNoteWithErrorMutation,
      variableValues: {
        input: {
          content: "attempted private quote",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", privateTarget.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, requester.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(quoteResult.errors, undefined);
    assert.deepEqual(toPlainJson(quoteResult.data), {
      createNote: {
        __typename: "InvalidInputError",
        inputPath: "quotedPostId",
      },
    });
  });
});

test("createNote rejects quoting none-visibility posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quotenoneauthor",
      name: "Quote None Author",
      email: "quotenoneauthor@example.com",
    });
    const { post: nonePost } = await insertNotePost(tx, {
      account: author.account,
      visibility: "none",
      content: "none-visibility post",
    });

    const quoteResult = await execute({
      schema,
      document: createNoteWithErrorMutation,
      variableValues: {
        input: {
          content: "attempted none quote",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", nonePost.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(quoteResult.errors, undefined);
    assert.deepEqual(toPlainJson(quoteResult.data), {
      createNote: {
        __typename: "InvalidInputError",
        inputPath: "quotedPostId",
      },
    });
  });
});

test("createNote rejects quoting followers-only posts by non-authors", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quotefollowersauthor",
      name: "Quote Followers Author",
      email: "quotefollowersauthor@example.com",
    });
    // A follower who can see the post should still not be able to quote it
    const follower = await insertAccountWithActor(tx, {
      username: "quotefollowersfollower",
      name: "Quote Followers Follower",
      email: "quotefollowersfollower@example.com",
    });
    await tx.insert(followingTable).values({
      iri:
        `https://example.com/following/${follower.actor.id}/${author.actor.id}`,
      followerId: follower.actor.id,
      followeeId: author.actor.id,
      accepted: new Date(),
    });
    const { post: followersPost } = await insertNotePost(tx, {
      account: author.account,
      visibility: "followers",
      content: "followers-only post",
    });

    const quoteResult = await execute({
      schema,
      document: createNoteWithErrorMutation,
      variableValues: {
        input: {
          content: "attempted followers quote by follower",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", followersPost.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, follower.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(quoteResult.errors, undefined);
    assert.deepEqual(toPlainJson(quoteResult.data), {
      createNote: {
        __typename: "InvalidInputError",
        inputPath: "quotedPostId",
      },
    });
  });
});

test("createNote allows author to quote their own followers-only post", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quotefollowersselfauthor",
      name: "Quote Followers Self Author",
      email: "quotefollowersselfauthor@example.com",
    });
    const { post: followersPost } = await insertNotePost(tx, {
      account: author.account,
      visibility: "followers",
      content: "followers-only post to self-quote",
    });

    const result = await execute({
      schema,
      document: createNoteMutation,
      variableValues: {
        input: {
          content: "author quoting own followers post",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", followersPost.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(
      (toPlainJson(result.data) as { createNote: { __typename: string } })
        .createNote.__typename,
      "CreateNotePayload",
    );
  });
});

test("createNote rejects quoting via a public wrapper of a non-quotable original", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quotewrapperauthor",
      name: "Quote Wrapper Author",
      email: "quotewrapperauthor@example.com",
    });
    const attacker = await insertAccountWithActor(tx, {
      username: "quotewrapperattacker",
      name: "Quote Wrapper Attacker",
      email: "quotewrapperattacker@example.com",
    });

    // Author creates a followers-only post and shares it (creating a public wrapper)
    const { post: original } = await insertNotePost(tx, {
      account: author.account,
      visibility: "followers",
      content: "followers-only original for quote bypass test",
    });
    const { post: wrapper } = await insertNotePost(tx, {
      account: author.account,
      visibility: "public",
      sharedPostId: original.id,
    });

    // Attacker tries to quote the original by submitting the wrapper's ID
    const result = await execute({
      schema,
      document: createNoteWithErrorMutation,
      variableValues: {
        input: {
          content: "quoting via public wrapper",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", wrapper.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, attacker.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(
      toPlainJson(result.data),
      {
        createNote: {
          __typename: "InvalidInputError",
          inputPath: "quotedPostId",
        },
      },
      "quoting via a public wrapper of a non-quotable original should be rejected",
    );
  });
});

test("createNote allows quoting public and unlisted posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quotepublicauthor",
      name: "Quote Public Author",
      email: "quotepublicauthor@example.com",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quotepublicquoter",
      name: "Quote Public Quoter",
      email: "quotepublicquoter@example.com",
    });
    const { post: publicPost } = await insertNotePost(tx, {
      account: author.account,
      visibility: "public",
      content: "public post to quote",
    });
    const { post: unlistedPost } = await insertNotePost(tx, {
      account: author.account,
      visibility: "unlisted",
      content: "unlisted post to quote",
    });

    const publicQuoteResult = await execute({
      schema,
      document: createNoteMutation,
      variableValues: {
        input: {
          content: "quoting a public post",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", publicPost.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, quoter.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(publicQuoteResult.errors, undefined);
    assert.equal(
      (toPlainJson(publicQuoteResult.data) as {
        createNote: { __typename: string };
      })
        .createNote.__typename,
      "CreateNotePayload",
    );

    const unlistedQuoteResult = await execute({
      schema,
      document: createNoteMutation,
      variableValues: {
        input: {
          content: "quoting an unlisted post",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", unlistedPost.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, quoter.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(unlistedQuoteResult.errors, undefined);
    assert.equal(
      (toPlainJson(unlistedQuoteResult.data) as {
        createNote: { __typename: string };
      })
        .createNote.__typename,
      "CreateNotePayload",
    );
  });
});

test("createNote sends QuoteRequest for remote manual-approval quotes", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quotemanualremote",
      name: "Quote Manual Remote",
      host: "remote.example",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quotemanualquoter",
      name: "Quote Manual Quoter",
      email: "quotemanualquoter@example.com",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Manual approval required</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const sent: unknown[][] = [];

    const result = await execute({
      schema,
      document: createNoteMutation,
      variableValues: {
        input: {
          content: "requesting quote approval",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", remotePost.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, quoter.account, {
        sendActivity(...args: unknown[]) {
          sent.push(args);
          return Promise.resolve(undefined);
        },
      }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(
      (toPlainJson(result.data) as { createNote: { __typename: string } })
        .createNote.__typename,
      "CreateNotePayload",
    );
    const request = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof QuoteRequest);
    assert.ok(request instanceof QuoteRequest);
    assert.ok(request.id != null);
    const fedCtx = createFedCtx(tx);
    const instrument = await request.getInstrument({
      ...fedCtx,
      suppressError: true,
    });
    assert.ok(instrument instanceof ActivityPubNote);
    assert.equal(instrument.quoteId?.href, remotePost.iri);
    assert.equal(instrument.quoteUrl?.href, remotePost.iri);
    const create = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof Create);
    assert.ok(create instanceof Create);
    const createdObject = await create.getObject({
      ...fedCtx,
      suppressError: true,
    });
    assert.ok(createdObject instanceof ActivityPubNote);
    assert.equal(createdObject.quoteId, null);
    assert.equal(createdObject.quoteUrl, null);
    const storedRequest = await tx.query.quoteRequestTable.findFirst({
      where: { iri: request.id.href },
    });
    assert.equal(storedRequest?.quotedPostId, remotePost.id);
    const createdQuote = await tx.query.postTable.findFirst({
      where: { actorId: quoter.actor.id },
    });
    assert.equal(createdQuote?.quotedPostId, null);
    assert.equal(createdQuote?.quoteTargetState, "pending");
    const storedRemotePost = await tx.query.postTable.findFirst({
      where: { id: remotePost.id },
    });
    assert.equal(storedRemotePost?.quotesCount, 0);
  });
});

test("createNote stores QuoteRequest for local manual-approval quotes", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "quotemanualowner",
      name: "Quote Manual Owner",
      email: "quotemanualowner@example.com",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quotemanualocal",
      name: "Quote Manual Local",
      email: "quotemanualocal@example.com",
    });
    const { post: localPost } = await insertNotePost(tx, {
      account: owner.account,
      content: "Manual approval required locally",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const sent: unknown[][] = [];

    const result = await execute({
      schema,
      document: createNoteMutation,
      variableValues: {
        input: {
          content: "requesting local quote approval",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", localPost.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, quoter.account, {
        sendActivity(...args: unknown[]) {
          sent.push(args);
          return Promise.resolve(undefined);
        },
      }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(
      (toPlainJson(result.data) as { createNote: { __typename: string } })
        .createNote.__typename,
      "CreateNotePayload",
    );
    const createdQuote = await tx.query.postTable.findFirst({
      where: { actorId: quoter.actor.id },
    });
    assert.ok(createdQuote != null);
    assert.equal(createdQuote.quotedPostId, null);
    assert.equal(createdQuote.quoteAuthorizationIri, null);
    assert.equal(createdQuote.quoteTargetState, "pending");
    const storedRequest = await tx.query.quoteRequestTable.findFirst({
      where: {
        quotePostId: createdQuote.id,
        quotedPostId: localPost.id,
      },
    });
    assert.ok(storedRequest != null);
    const sentRequest = sent.find((args) => args[2] instanceof QuoteRequest);
    assert.ok(sentRequest != null);
    assert.equal(
      (sentRequest[3] as { excludeBaseUris?: unknown }).excludeBaseUris,
      undefined,
    );
    const storedLocalPost = await tx.query.postTable.findFirst({
      where: { id: localPost.id },
    });
    assert.equal(storedLocalPost?.quotesCount, 0);
  });
});

test("createNote does not send QuoteRequest for automatic remote quotes", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quoteautomaticremote",
      name: "Quote Automatic Remote",
      host: "remote.example",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quoteautomaticquoter",
      name: "Quote Automatic Quoter",
      email: "quoteautomaticquoter@example.com",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Automatic quote allowed</p>",
      quotePolicy: "everyone",
      quoteRequestPolicy: "everyone",
    });
    const sent: unknown[][] = [];

    const result = await execute({
      schema,
      document: createNoteMutation,
      variableValues: {
        input: {
          content: "quoting automatically allowed remote post",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", remotePost.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, quoter.account, {
        sendActivity(...args: unknown[]) {
          sent.push(args);
          return Promise.resolve(undefined);
        },
      }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(
      (toPlainJson(result.data) as { createNote: { __typename: string } })
        .createNote.__typename,
      "CreateNotePayload",
    );
    const request = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof QuoteRequest);
    assert.equal(request, undefined);
    const storedRequest = await tx.query.quoteRequestTable.findFirst({
      where: { quotedPostId: remotePost.id },
    });
    assert.equal(storedRequest, undefined);
  });
});

test("createNote rejects remote quotes without automatic or manual permission", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quotedenyremote",
      name: "Quote Deny Remote",
      host: "remote.example",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quotedenyquoter",
      name: "Quote Deny Quoter",
      email: "quotedenyquoter@example.com",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Quote denied</p>",
      quotePolicy: "self",
    });

    const result = await execute({
      schema,
      document: createNoteWithErrorMutation,
      variableValues: {
        input: {
          content: "attempted denied remote quote",
          language: "en",
          visibility: "PUBLIC",
          quotedPostId: encodeGlobalID("Note", remotePost.id),
        },
      },
      contextValue: makeTransactionalUserContext(tx, quoter.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      createNote: {
        __typename: "InvalidInputError",
        inputPath: "quotedPostId",
      },
    });
  });
});

test("revokeQuote rejects remote quotes without an authorization", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "revokelegacyquoteauthor",
      name: "Revoke Legacy Quote Author",
      email: "revokelegacyquoteauthor@example.com",
    });
    const remoteActor = await insertRemoteActor(tx, {
      username: "revokelegacyquoter",
      name: "Revoke Legacy Quoter",
      host: "remote.example",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Locally authored quote target",
    });
    const remoteQuote = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      quotedPostId: quotedPost.id,
      contentHtml: "<p>Legacy remote quote without authorization</p>",
    });
    const quoteId = encodeGlobalID("Note", remoteQuote.id);
    const contextValue = makeTransactionalUserContext(tx, author.account);

    const viewerResult = await execute({
      schema,
      document: viewerCanRevokeQuoteQuery,
      variableValues: { id: quoteId },
      contextValue,
      onError: "NO_PROPAGATE",
    });

    assert.equal(viewerResult.errors, undefined);
    assert.deepEqual(toPlainJson(viewerResult.data), {
      node: {
        viewerCanRevokeQuote: false,
      },
    });

    const revokeResult = await execute({
      schema,
      document: revokeQuoteMutation,
      variableValues: {
        input: { quotePostId: quoteId },
      },
      contextValue,
      onError: "NO_PROPAGATE",
    });

    assert.equal(revokeResult.errors, undefined);
    assert.deepEqual(toPlainJson(revokeResult.data), {
      revokeQuote: {
        __typename: "InvalidInputError",
        inputPath: "quotePostId",
      },
    });
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: remoteQuote.id },
    });
    assert.equal(storedQuote?.quotedPostId, quotedPost.id);
  });
});

test("createNote validates attached media inside the transaction", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "createnotemissingmedia",
      name: "Create Note Missing Media",
      email: "createnotemissingmedia@example.com",
    });

    const result = await execute({
      schema,
      document: createNoteWithErrorMutation,
      variableValues: {
        input: {
          content: "note with missing media",
          language: "en",
          visibility: "PUBLIC",
          media: [{
            mediumId: crypto.randomUUID(),
            alt: "Missing image",
          }],
        },
      },
      contextValue: makeTransactionalUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      createNote: {
        __typename: "InvalidInputError",
        inputPath: "media.0.mediumId",
      },
    });
  });
});

test("deletePost rejects deleting shared posts and postByUrl resolves owned posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "deletepostauthor",
      name: "Delete Post Author",
      email: "deletepostauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "deletepostsharer",
      name: "Delete Post Sharer",
      email: "deletepostsharer@example.com",
    });
    const { post: original } = await insertNotePost(tx, {
      account: author.account,
      content: "Delete target",
    });
    const { post: share } = await insertNotePost(tx, {
      account: sharer.account,
      content: "Shared delete target",
      sharedPostId: original.id,
    });

    const deleteResult = await execute({
      schema,
      document: deletePostMutation,
      variableValues: {
        id: encodeGlobalID("Note", share.id),
      },
      contextValue: makeUserContext(tx, sharer.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(deleteResult.errors, undefined);
    assert.deepEqual(toPlainJson(deleteResult.data), {
      deletePost: {
        __typename: "SharedPostDeletionNotAllowedError",
        inputPath: "id",
      },
    });

    const lookupResult = await execute({
      schema,
      document: postByUrlQuery,
      variableValues: { url: original.url },
      contextValue: makeUserContext(tx, sharer.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(lookupResult.errors, undefined);
    assert.deepEqual(toPlainJson(lookupResult.data), {
      postByUrl: {
        id: encodeGlobalID("Note", original.id),
      },
    });
  });
});

const requestArticleTranslationMutation = parse(`
  mutation RequestArticleTranslation($input: RequestArticleTranslationInput!) {
    requestArticleTranslation(input: $input) {
      __typename
      ... on RequestArticleTranslationPayload {
        article {
          id
          contents(language: "ko", includeBeingTranslated: true) {
            language
            originalLanguage
            beingTranslated
          }
        }
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on LlmTranslationNotAllowedError {
        reason
      }
    }
  }
`);

// Same payload shape as `requestArticleTranslationMutation`, but the
// inner `contents(language: ...)` query takes the language as a
// variable so tests that queue translations into languages other than
// Korean can still introspect the freshly inserted row.
const requestArticleTranslationMutationByLanguage = parse(`
  mutation RequestArticleTranslationByLanguage(
    $input: RequestArticleTranslationInput!
    $language: Locale!
  ) {
    requestArticleTranslation(input: $input) {
      __typename
      ... on RequestArticleTranslationPayload {
        article {
          id
          contents(language: $language, includeBeingTranslated: true) {
            language
            originalLanguage
            beingTranslated
          }
        }
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on LlmTranslationNotAllowedError {
        reason
      }
    }
  }
`);

interface TranslatableArticleFixture {
  author: Awaited<ReturnType<typeof insertAccountWithActor>>;
  postId: Uuid;
  sourceId: Uuid;
}

async function insertTranslatableArticle(
  tx: Parameters<typeof withRollback>[0] extends (tx: infer T) => Promise<void>
    ? T
    : never,
  options: {
    username: string;
    slug: string;
    allowLlmTranslation?: boolean;
    language?: string;
    visibility?: "public" | "unlisted" | "followers" | "direct" | "none";
  },
): Promise<TranslatableArticleFixture> {
  const author = await insertAccountWithActor(tx, {
    username: options.username,
    name: options.username,
    email: `${options.username}@example.com`,
  });
  const sourceId = generateUuidV7();
  const postId = generateUuidV7();
  const published = new Date("2026-04-15T00:00:00.000Z");
  const language = options.language ?? "en";

  await tx.insert(articleSourceTable).values({
    id: sourceId,
    accountId: author.account.id,
    publishedYear: 2026,
    slug: options.slug,
    tags: [],
    allowLlmTranslation: options.allowLlmTranslation ?? true,
    published,
    updated: published,
  });
  await tx.insert(articleContentTable).values({
    sourceId,
    language,
    title: "Hello",
    content: "Plain article body without any external links.",
    published,
    updated: published,
  });
  await tx.insert(postTable).values(
    {
      id: postId,
      iri: `http://localhost/objects/${postId}`,
      type: "Article",
      visibility: options.visibility ?? "public",
      actorId: author.actor.id,
      articleSourceId: sourceId,
      name: "Hello",
      contentHtml: "<p>Plain article body without any external links.</p>",
      language,
      tags: {},
      emojis: {},
      url: `http://localhost/@${author.account.username}/2026/${options.slug}`,
      published,
      updated: published,
    } satisfies NewPost,
  );

  return { author, postId: postId as Uuid, sourceId: sourceId as Uuid };
}

function makeUserContextWithStubbedTranslator(
  tx: Parameters<typeof withRollback>[0] extends (tx: infer T) => Promise<void>
    ? T
    : never,
  account: Parameters<typeof makeUserContext>[1],
): UserContext {
  // Stub the translator with a hanging LanguageModel so the queued
  // `beingTranslated: true` row is never deleted by the
  // failure-cleanup branch of `startArticleContentTranslation` while
  // the test is asserting on the mutation's response.
  const fedCtx = createFedCtx(tx);
  fedCtx.data.models = {
    summarizer: {} as never,
    translator: {
      specificationVersion: "v2",
      provider: "test",
      modelId: "hang",
      supportedUrls: {},
      doGenerate: () => new Promise<never>(() => {}),
      doStream: () => new Promise<never>(() => {}),
    },
  } as unknown as typeof fedCtx.data.models;
  return makeUserContext(tx, account, { fedCtx });
}

test("requestArticleTranslation rejects guests", async () => {
  await withRollback(async (tx) => {
    const { postId } = await insertTranslatableArticle(tx, {
      username: "rattranslateguest",
      slug: "guest",
    });

    const result = await execute({
      schema,
      document: requestArticleTranslationMutation,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", postId),
          targetLanguage: "ko",
        },
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "NotAuthenticatedError",
        notAuthenticated: "",
      },
    });
  });
});

test("requestArticleTranslation rejects non-existent articleId", async () => {
  await withRollback(async (tx) => {
    const requester = await insertAccountWithActor(tx, {
      username: "rattranslatemissing",
      name: "Translation Requester Missing",
      email: "rattranslatemissing@example.com",
    });

    const result = await execute({
      schema,
      document: requestArticleTranslationMutation,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", generateUuidV7()),
          targetLanguage: "ko",
        },
      },
      contextValue: makeUserContext(tx, requester.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "InvalidInputError",
        inputPath: "articleId",
      },
    });
  });
});

test("requestArticleTranslation rejects non-Article posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "rattranslatenotearticle",
      name: "Translation Note Article",
      email: "rattranslatenotearticle@example.com",
    });
    const note = await insertNotePost(tx, { account: author.account });

    const result = await execute({
      schema,
      document: requestArticleTranslationMutation,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", note.post.id),
          targetLanguage: "ko",
        },
      },
      contextValue: makeUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "InvalidInputError",
        inputPath: "articleId",
      },
    });
  });
});

test("requestArticleTranslation rejects articles the viewer cannot see", async () => {
  await withRollback(async (tx) => {
    const { postId } = await insertTranslatableArticle(tx, {
      username: "rattranslatehidden",
      slug: "hidden",
      visibility: "direct",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "rattranslatehiddenrequester",
      name: "Hidden Requester",
      email: "rattranslatehiddenrequester@example.com",
    });

    const result = await execute({
      schema,
      document: requestArticleTranslationMutation,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", postId),
          targetLanguage: "ko",
        },
      },
      contextValue: makeUserContext(tx, requester.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "InvalidInputError",
        inputPath: "articleId",
      },
    });
  });
});

test("requestArticleTranslation rejects articles with allowLlmTranslation=false", async () => {
  await withRollback(async (tx) => {
    const { postId } = await insertTranslatableArticle(tx, {
      username: "rattranslatedisabled",
      slug: "disabled",
      allowLlmTranslation: false,
    });
    const requester = await insertAccountWithActor(tx, {
      username: "rattranslatedisabledrequester",
      name: "Disabled Requester",
      email: "rattranslatedisabledrequester@example.com",
    });

    const result = await execute({
      schema,
      document: requestArticleTranslationMutation,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", postId),
          targetLanguage: "ko",
        },
      },
      contextValue: makeUserContext(tx, requester.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "LlmTranslationNotAllowedError",
        reason: "DISABLED",
      },
    });
  });
});

test("requestArticleTranslation rejects requests where target language equals the original", async () => {
  await withRollback(async (tx) => {
    const { postId } = await insertTranslatableArticle(tx, {
      username: "rattranslatesamelang",
      slug: "samelang",
      language: "ko",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "rattranslatesamelangrequester",
      name: "Same Lang Requester",
      email: "rattranslatesamelangrequester@example.com",
    });

    const result = await execute({
      schema,
      document: requestArticleTranslationMutation,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", postId),
          targetLanguage: "ko",
        },
      },
      contextValue: makeUserContext(tx, requester.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "LlmTranslationNotAllowedError",
        reason: "SAME_LANGUAGE",
      },
    });
  });
});

test("requestArticleTranslation rejects regional variants of the source language", async () => {
  // `Article.contents(language: ...)` negotiates among available
  // locales rather than requiring an exact tag, so allowing a
  // same-family target (`en` -> `en-US`, `ko` -> `ko-KR`) would
  // create a redundant placeholder row whose canonical URL would
  // negotiate back to the existing source content and leave the
  // newly inserted row unreachable.
  await withRollback(async (tx) => {
    const { postId } = await insertTranslatableArticle(tx, {
      username: "rattranslatesamefamily",
      slug: "samefamily",
      language: "en",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "rattranslatesamefamilyrequester",
      name: "Same Family Requester",
      email: "rattranslatesamefamilyrequester@example.com",
    });

    const result = await execute({
      schema,
      document: requestArticleTranslationMutation,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", postId),
          targetLanguage: "en-US",
        },
      },
      contextValue: makeUserContext(tx, requester.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "LlmTranslationNotAllowedError",
        reason: "SAME_LANGUAGE",
      },
    });
  });
});

test("requestArticleTranslation allows cross-script variants of the same language", async () => {
  // Simplified vs Traditional Chinese genuinely produce a different
  // translation output, so `zh-CN` -> `zh-TW` (and vice versa) must
  // be allowed even though both share the `zh` language subtag.  The
  // language+script comparison in the resolver permits this because
  // `zh-CN` maximizes to `zh-Hans-CN` while `zh-TW` maximizes to
  // `zh-Hant-TW`.
  await withRollback(async (tx) => {
    const { postId, sourceId } = await insertTranslatableArticle(tx, {
      username: "rattranslatecrossscript",
      slug: "crossscript",
      language: "zh-CN",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "rattranslatecrossscriptrequester",
      name: "Cross Script Requester",
      email: "rattranslatecrossscriptrequester@example.com",
    });

    const result = await execute({
      schema,
      document: requestArticleTranslationMutationByLanguage,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", postId),
          targetLanguage: "zh-TW",
        },
        language: "zh-TW",
      },
      contextValue: makeUserContextWithStubbedTranslator(tx, requester.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "RequestArticleTranslationPayload",
        article: {
          id: encodeGlobalID("Article", postId),
          contents: [
            {
              language: "zh-TW",
              originalLanguage: "zh-CN",
              beingTranslated: true,
            },
          ],
        },
      },
    });

    const stored = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "zh-TW" },
    });
    assert.ok(stored != null);
    assert.equal(stored.beingTranslated, true);
    assert.equal(stored.originalLanguage, "zh-CN");
  });
});

test("requestArticleTranslation rejects locales not on the project allow-list", async () => {
  // The `Locale` scalar would happily accept any well-formed BCP 47
  // tag, but the `[lang]` route only serves locales that pass
  // `normalizeLocale` (the same `POSSIBLE_LOCALES` whitelist used
  // across the project), so the mutation should refuse anything the
  // canonical article URL flow can't display.  Pick a tag that's a
  // valid BCP 47 string but missing from `POSSIBLE_LOCALES`.
  await withRollback(async (tx) => {
    const { postId } = await insertTranslatableArticle(tx, {
      username: "rattranslateunknownlang",
      slug: "unknown-lang",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "rattranslateunknownlangrequester",
      name: "Unknown Lang Requester",
      email: "rattranslateunknownlangrequester@example.com",
    });

    const result = await execute({
      schema,
      document: requestArticleTranslationMutation,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", postId),
          // `ka-GE` (Georgian / Georgia): valid BCP 47, but the
          // project's `POSSIBLE_LOCALES` only contains `ka` for
          // Georgian.
          targetLanguage: "ka-GE",
        },
      },
      contextValue: makeUserContext(tx, requester.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "InvalidInputError",
        inputPath: "targetLanguage",
      },
    });
  });
});

test("requestArticleTranslation queues an in-progress translation row", async () => {
  await withRollback(async (tx) => {
    const { postId, sourceId } = await insertTranslatableArticle(tx, {
      username: "rattranslateok",
      slug: "ok",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "rattranslateokrequester",
      name: "OK Requester",
      email: "rattranslateokrequester@example.com",
    });

    const result = await execute({
      schema,
      document: requestArticleTranslationMutation,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", postId),
          targetLanguage: "ko",
        },
      },
      contextValue: makeUserContextWithStubbedTranslator(tx, requester.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "RequestArticleTranslationPayload",
        article: {
          id: encodeGlobalID("Article", postId),
          contents: [
            {
              language: "ko",
              originalLanguage: "en",
              beingTranslated: true,
            },
          ],
        },
      },
    });

    const stored = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.ok(stored != null);
    assert.equal(stored.beingTranslated, true);
    assert.equal(stored.originalLanguage, "en");
    assert.equal(stored.translationRequesterId, requester.account.id);
  });
});

test("requestArticleTranslation skips enqueueing when a completed translation already exists", async () => {
  // The model layer is already idempotent against this case (it
  // returns early without invoking the translator), but the resolver
  // can short-circuit even earlier from the already-fetched
  // `articleSource.contents`.  Exercise the early return by stubbing
  // the translator with one that throws if invoked: a successful
  // mutation response that doesn't disturb the existing row proves
  // the precheck fired.
  await withRollback(async (tx) => {
    const { postId, sourceId, author } = await insertTranslatableArticle(tx, {
      username: "rattranslatealready",
      slug: "alreadytranslated",
    });
    // Insert a completed `ko` translation alongside the original `en`
    // row so the resolver's precheck has something to match.
    const existingPublished = new Date("2026-04-16T00:00:00.000Z");
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ko",
      title: "안녕",
      content: "이미 번역된 본문.",
      originalLanguage: "en",
      beingTranslated: false,
      translationRequesterId: author.account.id,
      published: existingPublished,
      updated: existingPublished,
    });
    const requester = await insertAccountWithActor(tx, {
      username: "rattranslatealreadyrequester",
      name: "Already Requester",
      email: "rattranslatealreadyrequester@example.com",
    });

    const fedCtx = createFedCtx(tx);
    let translatorCalled = false;
    fedCtx.data.models = {
      summarizer: {} as never,
      translator: {
        specificationVersion: "v2",
        provider: "test",
        modelId: "throw",
        supportedUrls: {},
        doGenerate: () => {
          translatorCalled = true;
          throw new Error(
            "translator should not be invoked when a completed " +
              "translation already exists",
          );
        },
        doStream: () => {
          translatorCalled = true;
          throw new Error(
            "translator should not be invoked when a completed " +
              "translation already exists",
          );
        },
      },
    } as unknown as typeof fedCtx.data.models;

    const result = await execute({
      schema,
      document: requestArticleTranslationMutationByLanguage,
      variableValues: {
        input: {
          articleId: encodeGlobalID("Article", postId),
          targetLanguage: "ko",
        },
        language: "ko",
      },
      contextValue: makeUserContext(tx, requester.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      requestArticleTranslation: {
        __typename: "RequestArticleTranslationPayload",
        article: {
          id: encodeGlobalID("Article", postId),
          contents: [
            {
              language: "ko",
              originalLanguage: "en",
              beingTranslated: false,
            },
          ],
        },
      },
    });
    assert.equal(translatorCalled, false);

    // The pre-existing row must be untouched: not flipped back to
    // `beingTranslated`, not re-stamped with the new requester.
    const stored = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.ok(stored != null);
    assert.equal(stored.beingTranslated, false);
    assert.equal(stored.translationRequesterId, author.account.id);
  });
});

test("sharePost rejects sharing non-public posts by non-authors", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "shareprivateauthor",
      name: "Share Private Author",
      email: "shareprivateauthor@example.com",
    });
    const follower = await insertAccountWithActor(tx, {
      username: "shareprivatesharer",
      name: "Share Private Sharer",
      email: "shareprivatesharer@example.com",
    });

    // Set up an accepted follow so the follower can see followers-only posts
    await tx.insert(followingTable).values({
      iri:
        `https://example.com/following/${follower.actor.id}/${author.actor.id}`,
      followerId: follower.actor.id,
      followeeId: author.actor.id,
      accepted: new Date(),
    });

    for (
      const [visibility, label] of [
        ["followers", "followers-only"],
        ["direct", "direct"],
        ["none", "none-visibility"],
      ] as const
    ) {
      const { post } = await insertNotePost(tx, {
        account: author.account,
        visibility,
        content: `${label} post`,
      });

      const result = await execute({
        schema,
        document: sharePostMutation,
        variableValues: {
          postId: encodeGlobalID("Note", post.id),
        },
        contextValue: makeTransactionalUserContext(tx, follower.account),
        onError: "NO_PROPAGATE",
      });

      assert.equal(result.errors, undefined, `${label} share should not throw`);
      assert.deepEqual(
        toPlainJson(result.data),
        {
          sharePost: {
            __typename: "InvalidInputError",
            inputPath: "postId",
          },
        },
        `${label} share by non-author should be rejected`,
      );
    }
  });
});

test("sharePost allows author to share their own followers-only posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "shareownfollowersauthor",
      name: "Share Own Followers Author",
      email: "shareownfollowersauthor@example.com",
    });

    const { post } = await insertNotePost(tx, {
      account: author.account,
      visibility: "followers",
      content: "own followers-only post",
    });

    const result = await execute({
      schema,
      document: sharePostMutation,
      variableValues: {
        postId: encodeGlobalID("Note", post.id),
      },
      contextValue: makeTransactionalUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(
      (toPlainJson(result.data) as {
        sharePost: { __typename: string };
      }).sharePost.__typename,
      "SharePostPayload",
      "author should be able to share their own followers-only post",
    );
  });
});

test("sharePost rejects sharing direct posts even by their author", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "sharedirectauthor",
      name: "Share Direct Author",
      email: "sharedirectauthor@example.com",
    });

    for (
      const [visibility, label] of [
        ["direct", "direct"],
        ["none", "none-visibility"],
      ] as const
    ) {
      const { post } = await insertNotePost(tx, {
        account: author.account,
        visibility,
        content: `own ${label} post`,
      });

      const result = await execute({
        schema,
        document: sharePostMutation,
        variableValues: {
          postId: encodeGlobalID("Note", post.id),
        },
        contextValue: makeTransactionalUserContext(tx, author.account),
        onError: "NO_PROPAGATE",
      });

      assert.equal(result.errors, undefined);
      assert.deepEqual(
        toPlainJson(result.data),
        {
          sharePost: {
            __typename: "InvalidInputError",
            inputPath: "postId",
          },
        },
        `${label} post should not be shareable even by the author`,
      );
    }
  });
});

test("sharePost rejects sharing via a public wrapper of a non-shareable original", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "sharewrapperauthor",
      name: "Share Wrapper Author",
      email: "sharewrapperauthor@example.com",
    });
    const attacker = await insertAccountWithActor(tx, {
      username: "sharewrapperattacker",
      name: "Share Wrapper Attacker",
      email: "sharewrapperattacker@example.com",
    });

    // Author creates a followers-only post and then shares it themselves
    // (creating a public share wrapper)
    const { post: original } = await insertNotePost(tx, {
      account: author.account,
      visibility: "followers",
      content: "followers-only original",
    });
    const { post: wrapper } = await insertNotePost(tx, {
      account: author.account,
      visibility: "public",
      sharedPostId: original.id,
    });

    // Attacker attempts to share the original by submitting the wrapper's ID
    const result = await execute({
      schema,
      document: sharePostMutation,
      variableValues: {
        postId: encodeGlobalID("Note", wrapper.id),
      },
      contextValue: makeTransactionalUserContext(tx, attacker.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(
      toPlainJson(result.data),
      {
        sharePost: {
          __typename: "InvalidInputError",
          inputPath: "postId",
        },
      },
      "sharing via a public wrapper of a non-shareable original should be rejected",
    );
  });
});

test("sharePost allows sharing public and unlisted posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "sharepublicauthor",
      name: "Share Public Author",
      email: "sharepublicauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "sharepublicsharer",
      name: "Share Public Sharer",
      email: "sharepublicsharer@example.com",
    });

    for (
      const [visibility, label] of [
        ["public", "public"],
        ["unlisted", "unlisted"],
      ] as const
    ) {
      const { post } = await insertNotePost(tx, {
        account: author.account,
        visibility,
        content: `${label} post to share`,
      });

      const result = await execute({
        schema,
        document: sharePostMutation,
        variableValues: {
          postId: encodeGlobalID("Note", post.id),
        },
        contextValue: makeTransactionalUserContext(tx, sharer.account),
        onError: "NO_PROPAGATE",
      });

      assert.equal(result.errors, undefined);
      assert.equal(
        (toPlainJson(result.data) as {
          sharePost: { __typename: string };
        }).sharePost.__typename,
        "SharePostPayload",
        `${label} post should be shareable`,
      );
    }
  });
});

const updateNoteMutation = parse(`
  mutation UpdateNote($input: UpdateNoteInput!) {
    updateNote(input: $input) {
      __typename
      ... on UpdateNotePayload {
        note {
          id
          rawContent
          language
          visibility
          quotePolicy
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`);

test("updateNote updates content and language of a local note", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "updatenoteauthor",
      name: "Update Note Author",
      email: "updatenoteauthor@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Original content",
      language: "en",
      visibility: "public",
    });

    const result = await execute({
      schema,
      document: updateNoteMutation,
      variableValues: {
        input: {
          noteId: encodeGlobalID("Note", post.id),
          content: "Updated _content_",
          language: "ko",
        },
      },
      contextValue: makeTransactionalUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const payload = (toPlainJson(result.data) as {
      updateNote: {
        __typename: string;
        note: {
          id: string;
          rawContent: string;
          language: string;
          visibility: string;
          quotePolicy: string;
        };
      };
    }).updateNote;
    assert.equal(payload.__typename, "UpdateNotePayload");
    assert.equal(payload.note.id, encodeGlobalID("Note", post.id));
    assert.equal(payload.note.rawContent, "Updated _content_");
    assert.equal(payload.note.language, "ko");

    const storedSource = await tx.query.noteSourceTable.findFirst({
      where: { id: post.noteSourceId! },
    });
    assert.equal(storedSource?.content, "Updated _content_");
    assert.equal(storedSource?.language, "ko");
  });
});

test("updateNote rejects unauthenticated requests", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "updatenoteunauth",
      name: "Update Note Unauth",
      email: "updatenoteunauth@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Some note",
      language: "en",
    });

    const result = await execute({
      schema,
      document: updateNoteMutation,
      variableValues: {
        input: {
          noteId: encodeGlobalID("Note", post.id),
          content: "Should not update",
        },
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(
      (toPlainJson(result.data) as {
        updateNote: { __typename: string };
      }).updateNote.__typename,
      "NotAuthenticatedError",
    );
  });
});

test("updateNote rejects editing another user's note", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "updatenoteowner",
      name: "Update Note Owner",
      email: "updatenoteowner@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "updatenotethief",
      name: "Update Note Thief",
      email: "updatenotethief@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Owner's note",
      language: "en",
    });

    const result = await execute({
      schema,
      document: updateNoteMutation,
      variableValues: {
        input: {
          noteId: encodeGlobalID("Note", post.id),
          content: "Stolen edit",
        },
      },
      contextValue: makeTransactionalUserContext(tx, other.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const payload = (toPlainJson(result.data) as {
      updateNote: { __typename: string; inputPath?: string };
    }).updateNote;
    assert.equal(payload.__typename, "InvalidInputError");
    assert.equal(payload.inputPath, "noteId");
  });
});

test("updateNote rejects non-existent note ID", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "updatenotemissing",
      name: "Update Note Missing",
      email: "updatenotemissing@example.com",
    });

    const result = await execute({
      schema,
      document: updateNoteMutation,
      variableValues: {
        input: {
          noteId: encodeGlobalID("Note", generateUuidV7()),
          content: "Ghost edit",
        },
      },
      contextValue: makeTransactionalUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const payload = (toPlainJson(result.data) as {
      updateNote: { __typename: string; inputPath?: string };
    }).updateNote;
    assert.equal(payload.__typename, "InvalidInputError");
    assert.equal(payload.inputPath, "noteId");
  });
});
