import assert from "node:assert/strict";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
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
  insertAccountWithActor,
  makeGuestContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const questionPollQuery = parse(`
  query QuestionPoll($id: ID!) {
    node(id: $id) {
      ... on Question {
        poll {
          multiple
          options {
            title
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
      ends: new Date("2026-04-16T00:00:00.000Z"),
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
          options: Array<{
            title: string;
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
    assert.deepEqual(
      poll.options.map((option) => option.title),
      ["TypeScript", "Rust"],
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
