import assert from "node:assert/strict";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import type { UserContext } from "./builder.ts";
import {
  articleContentTable,
  articleDraftTable,
  articleSourceTable,
  type NewPost,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  makeUserContext,
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

function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function makeTransactionalUserContext(
  tx: Parameters<typeof withRollback>[0] extends (tx: infer T) => Promise<void>
    ? T
    : never,
  account: Parameters<typeof makeUserContext>[1],
): UserContext {
  const baseFedCtx = createFedCtx(tx);
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
