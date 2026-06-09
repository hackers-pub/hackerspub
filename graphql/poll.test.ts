import assert from "node:assert";
import test from "node:test";
import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import { createQuestion } from "@hackerspub/models/question";
import {
  type NewPost,
  pollOptionTable,
  pollTable,
  pollVoteTable,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const pollEndsInFuture = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const pollEndedInPast = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

const questionPollQuery = parse(`
  query QuestionPoll($id: ID!) {
    node(id: $id) {
      ... on Question {
        poll {
          multiple
          closed
          viewerHasVoted
          options {
            index
            title
            viewerHasVoted
            votes(first: 10) {
              totalCount
              edges {
                node {
                  actor { id }
                }
              }
            }
          }
          votes(first: 10) {
            totalCount
            edges {
              node {
                actor { id }
                option { title }
              }
            }
          }
          voters(first: 10) {
            totalCount
            edges {
              node { id }
            }
          }
        }
      }
    }
  }
`);

const actorPostByUuidQuery = parse(`
  query ActorPostByUuid($handle: String!, $uuid: UUID!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $uuid) {
        __typename
        id
        iri
        ... on Question {
          sourceId
        }
      }
    }
  }
`);

const sharedQuestionPollQuery = parse(`
  query SharedQuestionPoll($id: ID!) {
    node(id: $id) {
      ... on Question {
        poll {
          multiple
        }
        sharedPost {
          __typename
          ... on Question {
            poll {
              multiple
              options {
                index
                title
              }
            }
          }
        }
      }
    }
  }
`);

const voteOnPollMutation = parse(`
  mutation VoteOnPoll($questionId: ID!, $optionIndices: [Int!]!) {
    voteOnPoll(input: {
      questionId: $questionId,
      optionIndices: $optionIndices,
    }) {
      __typename
      ... on VoteOnPollPayload {
        question {
          id
          poll {
            viewerHasVoted
            voters(first: 10) {
              totalCount
            }
            votes(first: 10) {
              totalCount
            }
            options {
              index
              title
              viewerHasVoted
              votes(first: 10) {
                totalCount
              }
            }
          }
        }
        poll {
          viewerHasVoted
        }
        votes {
          option {
            index
            title
            votes(first: 10) {
              totalCount
            }
          }
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

test("Question.poll exposes ordered options and vote connections", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "pollgraphqlauthor",
      name: "Poll GraphQL Author",
      email: "pollgraphqlauthor@example.com",
    });
    const firstVoter = await insertAccountWithActor(tx, {
      username: "pollgraphqlfirst",
      name: "Poll GraphQL First",
      email: "pollgraphqlfirst@example.com",
    });
    const secondVoter = await insertAccountWithActor(tx, {
      username: "pollgraphqlsecond",
      name: "Poll GraphQL Second",
      email: "pollgraphqlsecond@example.com",
    });
    const questionId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(postTable).values(
      {
        id: questionId,
        iri: `http://localhost/objects/${questionId}`,
        type: "Question",
        visibility: "public",
        actorId: author.actor.id,
        name: "Favorite language?",
        contentHtml: "<p>Favorite language?</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: `http://localhost/@${author.account.username}/polls/${questionId}`,
        published,
        updated: published,
      } satisfies NewPost,
    );
    await tx.insert(pollTable).values({
      postId: questionId,
      multiple: true,
      votersCount: 2,
      ends: pollEndedInPast(),
    });
    await tx.insert(pollOptionTable).values([
      { postId: questionId, index: 1, title: "Rust", votesCount: 1 },
      { postId: questionId, index: 0, title: "TypeScript", votesCount: 1 },
    ]);
    await tx.insert(pollVoteTable).values([
      {
        postId: questionId,
        optionIndex: 0,
        actorId: firstVoter.actor.id,
        created: new Date("2026-04-15T00:00:01.000Z"),
      },
      {
        postId: questionId,
        optionIndex: 1,
        actorId: secondVoter.actor.id,
        created: new Date("2026-04-15T00:00:02.000Z"),
      },
    ]);

    const result = await execute({
      schema,
      document: questionPollQuery,
      variableValues: { id: encodeGlobalID("Question", questionId) },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);

    const poll = (toPlainJson(result.data) as {
      node: {
        poll: {
          multiple: boolean;
          closed: boolean;
          viewerHasVoted: boolean;
          options: Array<{
            index: number;
            title: string;
            viewerHasVoted: boolean;
            votes: {
              totalCount: number;
              edges: Array<{ node: { actor: { id: string } } }>;
            };
          }>;
          votes: {
            totalCount: number;
            edges: Array<{
              node: { actor: { id: string }; option: { title: string } };
            }>;
          };
          voters: {
            totalCount: number;
            edges: Array<{ node: { id: string } }>;
          };
        };
      } | null;
    }).node?.poll;

    assert.ok(poll != null);
    assert.equal(poll.multiple, true);
    assert.equal(poll.closed, true);
    assert.equal(poll.viewerHasVoted, false);
    assert.deepEqual(
      poll.options.map((option) => ({
        index: option.index,
        title: option.title,
        viewerHasVoted: option.viewerHasVoted,
      })),
      [
        { index: 0, title: "TypeScript", viewerHasVoted: false },
        { index: 1, title: "Rust", viewerHasVoted: false },
      ],
    );
    assert.deepEqual(
      poll.options.map((option) => option.votes.totalCount),
      [1, 1],
    );
    assert.equal(poll.votes.totalCount, 2);
    assert.deepEqual(
      poll.votes.edges.map((edge) => edge.node.option.title).sort(),
      ["Rust", "TypeScript"],
    );
    assert.equal(poll.voters.totalCount, 2);
    assert.deepEqual(
      poll.voters.edges.map((edge) => edge.node.id).sort(),
      [
        encodeGlobalID("Actor", firstVoter.actor.id),
        encodeGlobalID("Actor", secondVoter.actor.id),
      ].sort(),
    );
  });
});

test("Actor.postByUuid resolves visible Question posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "polluuidlookup",
      name: "Poll UUID Lookup",
      email: "polluuidlookup@example.com",
    });
    const questionId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(postTable).values(
      {
        id: questionId,
        iri: `http://localhost/objects/${questionId}`,
        type: "Question",
        visibility: "public",
        actorId: author.actor.id,
        name: "Lookup poll?",
        contentHtml: "<p>Lookup poll?</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: `http://localhost/@${author.account.username}/polls/${questionId}`,
        published,
        updated: published,
      } satisfies NewPost,
    );
    await tx.insert(pollTable).values({
      postId: questionId,
      multiple: false,
      votersCount: 0,
      ends: pollEndsInFuture(),
    });
    await tx.insert(pollOptionTable).values([
      { postId: questionId, index: 0, title: "Yes", votesCount: 0 },
      { postId: questionId, index: 1, title: "No", votesCount: 0 },
    ]);

    const result = await execute({
      schema,
      document: actorPostByUuidQuery,
      variableValues: {
        handle: author.account.username,
        uuid: questionId,
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      actorByHandle: {
        postByUuid: {
          __typename: "Question",
          id: encodeGlobalID("Question", questionId),
          iri: `http://localhost/objects/${questionId}`,
          sourceId: null,
        },
      },
    });
  });
});

test("source-backed local Questions expose their Question ActivityPub IRI", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "pollgraphqlquestioniri",
      name: "Poll GraphQL Question IRI",
      email: "pollgraphqlquestioniri@example.com",
    });
    const fedCtx = {
      ...createFedCtx(tx),
      getObjectUri(type: unknown, values: Record<string, string>) {
        if (type === vocab.Question) {
          return new URL(`/ap/questions/${values.id}`, "http://localhost/");
        }
        return new URL(`/objects/${values.id}`, "http://localhost/");
      },
    } as ReturnType<typeof createFedCtx>;
    const published = new Date("2026-04-15T00:00:00.000Z");
    const question = await createQuestion(
      fedCtx as unknown as Context<ContextData<Transaction>>,
      {
        accountId: author.account.id,
        visibility: "public",
        quotePolicy: "everyone",
        content: "Which object route should be advertised?",
        language: "en",
        media: [],
        published,
        updated: published,
        poll: {
          title: "Object route",
          multiple: false,
          options: ["Question", "Note"],
          ends: new Date("2026-04-16T00:00:00.000Z"),
          now: published,
        },
      },
    );
    assert.ok(question != null);
    assert.ok(question.noteSourceId != null);

    const result = await execute({
      schema,
      document: actorPostByUuidQuery,
      variableValues: {
        handle: author.account.username,
        uuid: question.noteSourceId,
      },
      contextValue: makeGuestContext(tx, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      actorByHandle: {
        postByUuid: {
          __typename: "Question",
          id: encodeGlobalID("Question", question.id),
          iri: `http://localhost/ap/questions/${question.noteSourceId}`,
          sourceId: question.noteSourceId,
        },
      },
    });
  });
});

test("shared Question wrappers can resolve the original poll", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "pollgraphqlshareauthor",
      name: "Poll GraphQL Share Author",
      email: "pollgraphqlshareauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "pollgraphqlsharer",
      name: "Poll GraphQL Sharer",
      email: "pollgraphqlsharer@example.com",
    });
    const questionId = generateUuidV7();
    const shareId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(postTable).values([
      {
        id: questionId,
        iri: `http://localhost/objects/${questionId}`,
        type: "Question",
        visibility: "public",
        actorId: author.actor.id,
        name: "Shared poll?",
        contentHtml: "<p>Shared poll?</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: `http://localhost/@${author.account.username}/polls/${questionId}`,
        published,
        updated: published,
      } satisfies NewPost,
      {
        id: shareId,
        iri: `http://localhost/objects/${shareId}`,
        type: "Question",
        visibility: "public",
        actorId: sharer.actor.id,
        sharedPostId: questionId,
        name: "Shared poll?",
        contentHtml: "<p>Shared poll?</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: `http://localhost/@${sharer.account.username}/shares/${shareId}`,
        published,
        updated: published,
      } satisfies NewPost,
    ]);
    await tx.insert(pollTable).values({
      postId: questionId,
      multiple: false,
      votersCount: 0,
      ends: pollEndsInFuture(),
    });
    await tx.insert(pollOptionTable).values([
      { postId: questionId, index: 0, title: "Yes", votesCount: 0 },
      { postId: questionId, index: 1, title: "No", votesCount: 0 },
    ]);

    const result = await execute({
      schema,
      document: sharedQuestionPollQuery,
      variableValues: { id: encodeGlobalID("Question", shareId) },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      node: {
        poll: null,
        sharedPost: {
          __typename: "Question",
          poll: {
            multiple: false,
            options: [
              { index: 0, title: "Yes" },
              { index: 1, title: "No" },
            ],
          },
        },
      },
    });
  });
});

test("Question.poll backfills missing remote poll rows", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "backfillpollviewer",
      name: "Backfill Poll Viewer",
      email: "backfillpollviewer@example.com",
    });
    const author = await insertRemoteActor(tx, {
      username: "backfillpollauthor",
      name: "Backfill Poll Author",
      host: "remote.example",
      iri: "https://remote.example/users/backfillpollauthor",
    });
    const questionId = generateUuidV7();
    const questionIri = `https://remote.example/objects/${questionId}`;
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(postTable).values(
      {
        id: questionId,
        iri: questionIri,
        type: "Question",
        visibility: "public",
        actorId: author.id,
        name: "Backfill poll?",
        contentHtml: "<p>Backfill poll?</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: questionIri,
        published,
        updated: published,
      } satisfies NewPost,
    );

    const fedCtx = createFedCtx(tx);
    let lookupCount = 0;
    fedCtx.lookupObject = (url: string | URL) => {
      assert.equal(url.toString(), questionIri);
      lookupCount++;
      return Promise.resolve(
        new vocab.Question({
          id: new URL(questionIri),
          attribution: new URL(author.iri),
          to: vocab.PUBLIC_COLLECTION,
          content: "<p>Backfill poll?</p>",
          endTime: Temporal.Instant.from(pollEndsInFuture().toISOString()),
          inclusiveOptions: [
            new vocab.Note({ name: "TypeScript" }),
            new vocab.Note({ name: "Rust" }),
          ],
          voters: 3,
        }),
      );
    };

    const result = await execute({
      schema,
      document: questionPollQuery,
      variableValues: { id: encodeGlobalID("Question", questionId) },
      contextValue: makeUserContext(tx, viewer.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const poll = (toPlainJson(result.data) as {
      node: {
        poll: {
          multiple: boolean;
          voters: { totalCount: number };
          options: Array<{ index: number; title: string }>;
        } | null;
      } | null;
    }).node?.poll;

    assert.equal(lookupCount, 1);
    assert.ok(poll != null);
    assert.equal(poll.multiple, true);
    assert.equal(poll.voters.totalCount, 3);
    assert.deepEqual(
      poll.options.map((option) => ({
        index: option.index,
        title: option.title,
      })),
      [
        { index: 0, title: "TypeScript" },
        { index: 1, title: "Rust" },
      ],
    );

    const storedOptions = await tx.query.pollOptionTable.findMany({
      where: { postId: questionId },
      orderBy: { index: "asc" },
    });
    assert.deepEqual(
      storedOptions.map((option) => option.title),
      ["TypeScript", "Rust"],
    );
  });
});

test("Question.poll refuses federation lookup for guests", async () => {
  await withRollback(async (tx) => {
    const author = await insertRemoteActor(tx, {
      username: "guestbackfillauthor",
      name: "Guest Backfill Author",
      host: "remote.example",
      iri: "https://remote.example/users/guestbackfillauthor",
    });
    const questionId = generateUuidV7();
    const questionIri = `https://remote.example/objects/${questionId}`;
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(postTable).values(
      {
        id: questionId,
        iri: questionIri,
        type: "Question",
        visibility: "public",
        actorId: author.id,
        name: "Guest backfill?",
        contentHtml: "<p>Guest backfill?</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: questionIri,
        published,
        updated: published,
      } satisfies NewPost,
    );

    const lookupCalls: string[] = [];
    const fedCtx = createFedCtx(tx, {
      lookupObject: (uri) => {
        lookupCalls.push(uri.toString());
        return Promise.resolve(null);
      },
    });

    const result = await execute({
      schema,
      document: questionPollQuery,
      variableValues: { id: encodeGlobalID("Question", questionId) },
      contextValue: makeGuestContext(tx, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      node: {
        poll: null,
      },
    });
    assert.deepEqual(lookupCalls, []);
  });
});

test("Question.poll ignores non-Question remote backfills", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "nonquestionbackfillviewer",
      name: "Non-Question Backfill Viewer",
      email: "nonquestionbackfillviewer@example.com",
    });
    const author = await insertRemoteActor(tx, {
      username: "nonquestionbackfillauthor",
      name: "Non-Question Backfill Author",
      host: "remote.example",
      iri: "https://remote.example/users/nonquestionbackfillauthor",
    });
    const questionId = generateUuidV7();
    const questionIri = `https://remote.example/objects/${questionId}`;
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(postTable).values(
      {
        id: questionId,
        iri: questionIri,
        type: "Question",
        visibility: "public",
        actorId: author.id,
        name: "Backfill type mismatch?",
        contentHtml: "<p>Backfill type mismatch?</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: questionIri,
        published,
        updated: published,
      } satisfies NewPost,
    );

    const fedCtx = createFedCtx(tx);
    fedCtx.lookupObject = () =>
      Promise.resolve(
        new vocab.Note({
          id: new URL(questionIri),
          attribution: new URL(author.iri),
          to: vocab.PUBLIC_COLLECTION,
          content: "<p>This is not a Question.</p>",
        }),
      );

    const result = await execute({
      schema,
      document: questionPollQuery,
      variableValues: { id: encodeGlobalID("Question", questionId) },
      contextValue: makeUserContext(tx, viewer.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      node: {
        poll: null,
      },
    });

    const storedPost = await tx.query.postTable.findFirst({
      where: { id: questionId },
      columns: { type: true },
    });
    assert.equal(storedPost?.type, "Question");
  });
});

test("Question.poll returns null when remote backfill fails", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "failedbackfillpollviewer",
      name: "Failed Backfill Poll Viewer",
      email: "failedbackfillpollviewer@example.com",
    });
    const author = await insertRemoteActor(tx, {
      username: "failedbackfillpollauthor",
      name: "Failed Backfill Poll Author",
      host: "remote.example",
      iri: "https://remote.example/users/failedbackfillpollauthor",
    });
    const questionId = generateUuidV7();
    const questionIri = `https://remote.example/objects/${questionId}`;
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(postTable).values(
      {
        id: questionId,
        iri: questionIri,
        type: "Question",
        visibility: "public",
        actorId: author.id,
        name: "Missing poll?",
        contentHtml: "<p>Missing poll?</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: questionIri,
        published,
        updated: published,
      } satisfies NewPost,
    );

    const fedCtx = createFedCtx(tx);
    fedCtx.lookupObject = () => {
      throw new Error("remote instance unavailable");
    };

    const result = await execute({
      schema,
      document: questionPollQuery,
      variableValues: { id: encodeGlobalID("Question", questionId) },
      contextValue: makeUserContext(tx, viewer.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      node: {
        poll: null,
      },
    });
  });
});

test("voteOnPoll stores a single-choice vote and updates viewer fields", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "pollgraphqlvoteauthor",
      name: "Poll GraphQL Vote Author",
      email: "pollgraphqlvoteauthor@example.com",
    });
    const voter = await insertAccountWithActor(tx, {
      username: "pollgraphqlvoter",
      name: "Poll GraphQL Voter",
      email: "pollgraphqlvoter@example.com",
    });
    const questionId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");
    const questionGlobalId = encodeGlobalID("Question", questionId);

    await tx.insert(postTable).values(
      {
        id: questionId,
        iri: `http://localhost/objects/${questionId}`,
        type: "Question",
        visibility: "public",
        actorId: author.actor.id,
        name: "Vote poll?",
        contentHtml: "<p>Vote poll?</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: `http://localhost/@${author.account.username}/polls/${questionId}`,
        published,
        updated: published,
      } satisfies NewPost,
    );
    await tx.insert(pollTable).values({
      postId: questionId,
      multiple: false,
      votersCount: 0,
      ends: pollEndsInFuture(),
    });
    await tx.insert(pollOptionTable).values([
      { postId: questionId, index: 0, title: "TypeScript", votesCount: 0 },
      { postId: questionId, index: 1, title: "Rust", votesCount: 0 },
    ]);

    const result = await execute({
      schema,
      document: voteOnPollMutation,
      variableValues: {
        questionId: questionGlobalId,
        optionIndices: [1],
      },
      contextValue: makeUserContext(tx, voter.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const payload = (toPlainJson(result.data) as {
      voteOnPoll: {
        __typename: string;
        question?: {
          id: string;
          poll: {
            viewerHasVoted: boolean;
            voters: { totalCount: number };
            votes: { totalCount: number };
            options: Array<{
              index: number;
              title: string;
              viewerHasVoted: boolean;
              votes: { totalCount: number };
            }>;
          };
        };
        poll?: { viewerHasVoted: boolean };
        votes?: Array<{
          option: {
            index: number;
            title: string;
            votes: { totalCount: number };
          };
        }>;
      };
    }).voteOnPoll;

    assert.equal(payload.__typename, "VoteOnPollPayload");
    assert.equal(payload.question?.id, questionGlobalId);
    assert.equal(payload.question?.poll.viewerHasVoted, true);
    assert.equal(payload.poll?.viewerHasVoted, true);
    assert.equal(payload.question?.poll.voters.totalCount, 1);
    assert.equal(payload.question?.poll.votes.totalCount, 1);
    assert.deepEqual(payload.question?.poll.options, [
      {
        index: 0,
        title: "TypeScript",
        viewerHasVoted: false,
        votes: { totalCount: 0 },
      },
      {
        index: 1,
        title: "Rust",
        viewerHasVoted: true,
        votes: { totalCount: 1 },
      },
    ]);
    assert.deepEqual(payload.votes, [
      { option: { index: 1, title: "Rust", votes: { totalCount: 1 } } },
    ]);

    const repeat = await execute({
      schema,
      document: voteOnPollMutation,
      variableValues: {
        questionId: questionGlobalId,
        optionIndices: [0],
      },
      contextValue: makeUserContext(tx, voter.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(repeat.errors, undefined);
    const repeatPayload = (toPlainJson(repeat.data) as {
      voteOnPoll: {
        __typename: string;
        votes?: Array<{
          option: {
            index: number;
            title: string;
            votes: { totalCount: number };
          };
        }>;
      };
    }).voteOnPoll;
    assert.equal(repeatPayload.__typename, "VoteOnPollPayload");
    assert.deepEqual(repeatPayload.votes, [
      { option: { index: 1, title: "Rust", votes: { totalCount: 1 } } },
    ]);
  });
});

test("voteOnPoll stores multiple choices for multi-choice polls", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "pollgraphqlmultiauthor",
      name: "Poll GraphQL Multi Author",
      email: "pollgraphqlmultiauthor@example.com",
    });
    const voter = await insertAccountWithActor(tx, {
      username: "pollgraphqlmultivoter",
      name: "Poll GraphQL Multi Voter",
      email: "pollgraphqlmultivoter@example.com",
    });
    const questionId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(postTable).values(
      {
        id: questionId,
        iri: `http://localhost/objects/${questionId}`,
        type: "Question",
        visibility: "public",
        actorId: author.actor.id,
        name: "Multi vote poll?",
        contentHtml: "<p>Multi vote poll?</p>",
        language: "en",
        tags: {},
        emojis: {},
        url: `http://localhost/@${author.account.username}/polls/${questionId}`,
        published,
        updated: published,
      } satisfies NewPost,
    );
    await tx.insert(pollTable).values({
      postId: questionId,
      multiple: true,
      votersCount: 0,
      ends: pollEndsInFuture(),
    });
    await tx.insert(pollOptionTable).values([
      { postId: questionId, index: 0, title: "Red", votesCount: 0 },
      { postId: questionId, index: 1, title: "Blue", votesCount: 0 },
      { postId: questionId, index: 2, title: "Green", votesCount: 0 },
    ]);

    const result = await execute({
      schema,
      document: voteOnPollMutation,
      variableValues: {
        questionId: encodeGlobalID("Question", questionId),
        optionIndices: [0, 2],
      },
      contextValue: makeUserContext(tx, voter.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const payload = (toPlainJson(result.data) as {
      voteOnPoll: {
        __typename: string;
        question?: {
          poll: {
            voters: { totalCount: number };
            votes: { totalCount: number };
            options: Array<{
              index: number;
              viewerHasVoted: boolean;
              votes: { totalCount: number };
            }>;
          };
        };
        votes?: Array<{
          option: {
            index: number;
            title: string;
            votes: { totalCount: number };
          };
        }>;
      };
    }).voteOnPoll;

    assert.equal(payload.__typename, "VoteOnPollPayload");
    assert.equal(payload.question?.poll.voters.totalCount, 1);
    assert.equal(payload.question?.poll.votes.totalCount, 2);
    assert.deepEqual(
      payload.question?.poll.options.map((option) => ({
        index: option.index,
        viewerHasVoted: option.viewerHasVoted,
        totalCount: option.votes.totalCount,
      })),
      [
        { index: 0, viewerHasVoted: true, totalCount: 1 },
        { index: 1, viewerHasVoted: false, totalCount: 0 },
        { index: 2, viewerHasVoted: true, totalCount: 1 },
      ],
    );
    assert.deepEqual(
      payload.votes?.map((vote) => vote.option).sort((a, b) =>
        a.index - b.index
      ),
      [
        { index: 0, title: "Red", votes: { totalCount: 1 } },
        { index: 2, title: "Green", votes: { totalCount: 1 } },
      ],
    );
  });
});

test("voteOnPoll rejects guest, invalid, and expired votes", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "pollgraphqlrejectauthor",
      name: "Poll GraphQL Reject Author",
      email: "pollgraphqlrejectauthor@example.com",
    });
    const voter = await insertAccountWithActor(tx, {
      username: "pollgraphqlrejectvoter",
      name: "Poll GraphQL Reject Voter",
      email: "pollgraphqlrejectvoter@example.com",
    });
    const questionId = generateUuidV7();
    const expiredQuestionId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    for (
      const [id, ends] of [
        [questionId, pollEndsInFuture()],
        [expiredQuestionId, pollEndedInPast()],
      ] as const
    ) {
      await tx.insert(postTable).values(
        {
          id,
          iri: `http://localhost/objects/${id}`,
          type: "Question",
          visibility: "public",
          actorId: author.actor.id,
          name: "Reject poll?",
          contentHtml: "<p>Reject poll?</p>",
          language: "en",
          tags: {},
          emojis: {},
          url: `http://localhost/@${author.account.username}/polls/${id}`,
          published,
          updated: published,
        } satisfies NewPost,
      );
      await tx.insert(pollTable).values({
        postId: id,
        multiple: false,
        votersCount: 0,
        ends,
      });
      await tx.insert(pollOptionTable).values([
        { postId: id, index: 0, title: "Yes", votesCount: 0 },
        { postId: id, index: 1, title: "No", votesCount: 0 },
      ]);
    }

    const guestResult = await execute({
      schema,
      document: voteOnPollMutation,
      variableValues: {
        questionId: encodeGlobalID("Question", questionId),
        optionIndices: [0],
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(guestResult.errors, undefined);
    assert.equal(
      (toPlainJson(guestResult.data) as {
        voteOnPoll: { __typename: string };
      }).voteOnPoll.__typename,
      "NotAuthenticatedError",
    );

    for (
      const [optionIndices, expectedPath] of [
        [[], "optionIndices"],
        [[0, 0], "optionIndices"],
        [[0, 1], "optionIndices"],
        [[999], "optionIndices"],
      ] as const
    ) {
      const result = await execute({
        schema,
        document: voteOnPollMutation,
        variableValues: {
          questionId: encodeGlobalID("Question", questionId),
          optionIndices,
        },
        contextValue: makeUserContext(tx, voter.account),
        onError: "NO_PROPAGATE",
      });

      assert.equal(result.errors, undefined);
      assert.deepEqual(toPlainJson(result.data), {
        voteOnPoll: {
          __typename: "InvalidInputError",
          inputPath: expectedPath,
        },
      });
    }

    const expiredResult = await execute({
      schema,
      document: voteOnPollMutation,
      variableValues: {
        questionId: encodeGlobalID("Question", expiredQuestionId),
        optionIndices: [0],
      },
      contextValue: makeUserContext(tx, voter.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(expiredResult.errors, undefined);
    assert.deepEqual(toPlainJson(expiredResult.data), {
      voteOnPoll: {
        __typename: "InvalidInputError",
        inputPath: "questionId",
      },
    });
  });
});
