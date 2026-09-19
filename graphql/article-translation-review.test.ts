import assert from "node:assert";
import test from "node:test";
import { createArticle } from "@hackerspub/models/article";
import { saveArticleTranslationDraft } from "@hackerspub/models/article-translation";
import { getCurrentSourceRevision } from "@hackerspub/models/article-revision";
import { notificationTable } from "@hackerspub/models/schema";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const fakeModels = {
  summarizer: {} as never,
  translator: {} as never,
  moderationAnalyzer: {} as never,
};

const acknowledgeMutation = parse(`
  mutation Acknowledge(
    $sourceId: UUID!
    $language: Locale!
    $sourceRevisionId: UUID!
  ) {
    acknowledgeArticleTranslationSource(
      input: {
        sourceId: $sourceId
        language: $language
        sourceRevisionId: $sourceRevisionId
      }
    ) {
      __typename
      ... on AcknowledgeArticleTranslationSourcePayload {
        translationDraft {
          uuid
          reviewState
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on OrganizationPermissionError {
        message
      }
    }
  }
`);

const revisionNodeQuery = parse(`
  query RevisionNode($id: ID!) {
    node(id: $id) {
      __typename
      ... on ArticleSourceRevision {
        title
        content
      }
    }
  }
`);

const notificationNodeQuery = parse(`
  query NotificationNode($id: ID!) {
    node(id: $id) {
      __typename
      ... on ArticleTranslationSourceChangedNotification {
        languages
      }
    }
  }
`);

test("acknowledgeArticleTranslationSource records the review for an authorized editor", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "gqlackauthor",
      name: "GraphQL Ack Author",
      email: "gqlackauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "gql-acknowledge",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const draft = await saveArticleTranslationDraft(tx, author.account, {
      sourceId,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
    });
    assert.equal(draft.status, "ok");
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(current != null);

    const result = await execute({
      schema,
      document: acknowledgeMutation,
      variableValues: {
        sourceId,
        language: "ko",
        sourceRevisionId: current.id,
      },
      contextValue: makeUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const payload = (
      result.data as {
        acknowledgeArticleTranslationSource: {
          __typename: string;
          translationDraft: { reviewState: string } | null;
        };
      }
    ).acknowledgeArticleTranslationSource;
    assert.equal(
      payload.__typename,
      "AcknowledgeArticleTranslationSourcePayload",
    );
    assert.equal(payload.translationDraft?.reviewState, "CURRENT");
  });
});

test("a stranger cannot acknowledge or read another workspace's source revision", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "gqlrevowner",
      name: "GraphQL Revision Owner",
      email: "gqlrevowner@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "gqlrevstranger",
      name: "GraphQL Revision Stranger",
      email: "gqlrevstranger@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "gql-revision-privacy",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await saveArticleTranslationDraft(tx, author.account, {
      sourceId,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
    });
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(current != null);

    const acknowledged = await execute({
      schema,
      document: acknowledgeMutation,
      variableValues: {
        sourceId,
        language: "ko",
        sourceRevisionId: current.id,
      },
      contextValue: makeUserContext(tx, stranger.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      (
        acknowledged.data as {
          acknowledgeArticleTranslationSource: { __typename: string };
        }
      ).acknowledgeArticleTranslationSource.__typename,
      "OrganizationPermissionError",
    );

    // The snapshot holds the article's text as its editors see it, so
    // `node(id:)` must not hand it to anyone else.
    const revisionId = encodeGlobalID("ArticleSourceRevision", current.id);
    for (const contextValue of [
      makeUserContext(tx, stranger.account),
      makeGuestContext(tx),
    ]) {
      const read = await execute({
        schema,
        document: revisionNodeQuery,
        variableValues: { id: revisionId },
        contextValue,
        onError: "NO_PROPAGATE",
      });
      assert.equal((read.data as { node: unknown }).node, null);
    }

    // Its owner can read it.
    const owned = await execute({
      schema,
      document: revisionNodeQuery,
      variableValues: { id: revisionId },
      contextValue: makeUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(owned.errors, undefined);
    assert.equal(
      (owned.data as { node: { title: string } | null }).node?.title,
      "Original title",
    );
  });
});

test("a translation review notification is not readable by another account", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "gqlnotifowner",
      name: "GraphQL Notification Owner",
      email: "gqlnotifowner@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "gqlnotifstranger",
      name: "GraphQL Notification Stranger",
      email: "gqlnotifstranger@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "gql-notification-privacy",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(current != null);
    const notificationId = generateUuidV7();
    await tx.insert(notificationTable).values({
      id: notificationId,
      accountId: author.account.id,
      type: "article_translation_source_changed",
      postId: article.id,
      actorIds: [author.actor.id],
      articleSourceRevisionId: current.id,
      translationLanguages: ["ko"],
    });
    const globalId = encodeGlobalID(
      "ArticleTranslationSourceChangedNotification",
      notificationId,
    );

    const mine = await execute({
      schema,
      document: notificationNodeQuery,
      variableValues: { id: globalId },
      contextValue: makeUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(mine.errors, undefined);
    assert.deepEqual(
      (mine.data as { node: { languages: string[] } | null }).node?.languages,
      ["ko"],
    );

    for (const contextValue of [
      makeUserContext(tx, stranger.account),
      makeGuestContext(tx),
    ]) {
      const theirs = await execute({
        schema,
        document: notificationNodeQuery,
        variableValues: { id: globalId },
        contextValue,
        onError: "NO_PROPAGATE",
      });
      assert.equal((theirs.data as { node: unknown }).node, null);
    }
  });
});
