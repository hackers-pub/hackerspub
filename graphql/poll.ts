import * as vocab from "@fedify/vocab";
import { renderCustomEmojis } from "@hackerspub/models/emoji";
import { addExternalLinkTargets } from "@hackerspub/models/html";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { eq } from "drizzle-orm";
import { vote } from "@hackerspub/models/poll";
import { isPostVisibleTo, persistPost } from "@hackerspub/models/post";
import { pollVoteTable } from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";
import { Actor } from "./actor.ts";
import { builder, type UserContext } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { Post, Question } from "./post.ts";
import { PostVisibility, toPostVisibility } from "./postvisibility.ts";
import { NotAuthenticatedError } from "./session.ts";

const pollBranchComplexity = { field: 0, multiplier: 0 } as const;
const questionPollComplexity = { field: 0, multiplier: 0 } as const;

// These re-declare a few fields that already exist on the `Post` interface
// so they can carry the lower `questionPollComplexity` cost. Keep
// descriptions in sync with the `Post` interface so consumers browsing
// `Question` directly still see the warnings.
builder.drizzleObjectFields(Question, (t) => ({
  uuid: t.expose("id", {
    type: "UUID",
    complexity: questionPollComplexity,
    description:
      "The post row's primary key, stable for the lifetime of the post. " +
      "Question originals are only persisted from federated remote " +
      "instances; local Question rows may also exist as share wrappers " +
      "(boosts) when a local user reshares a remote question. Neither case " +
      "carries a local source row (a DB check constraint forbids " +
      "`noteSourceId` on non-Note rows), so this row PK is the right token " +
      "to use when building internal permalinks for questions — though " +
      "`Post.url` will still reflect whatever URL the originating instance " +
      "advertised, which generally won't share this UUID.",
  }),
  iri: t.field({
    type: "URL",
    complexity: questionPollComplexity,
    select: {
      columns: { iri: true },
    },
    resolve: (post) => new URL(post.iri),
  }),
  visibility: t.field({
    type: PostVisibility,
    complexity: questionPollComplexity,
    select: {
      columns: { visibility: true },
    },
    resolve(post) {
      return toPostVisibility(post.visibility);
    },
  }),
  content: t.field({
    type: "HTML",
    complexity: questionPollComplexity,
    select: {
      columns: {
        contentHtml: true,
        emojis: true,
      },
    },
    resolve: (post, _, ctx) =>
      addExternalLinkTargets(
        renderCustomEmojis(post.contentHtml, post.emojis),
        new URL(ctx.fedCtx.canonicalOrigin),
      ),
  }),
  language: t.exposeString("language", {
    nullable: true,
    complexity: questionPollComplexity,
  }),
  url: t.field({
    type: "URL",
    nullable: true,
    complexity: questionPollComplexity,
    description:
      "The canonical, human-readable URL of this question, as advertised by " +
      "the originating instance. Question originals are only persisted from " +
      "federated remote instances, and local share wrappers copy the shared " +
      "post's URL, so this never encodes a local-source identifier — do not " +
      "assume any relationship between its path and `Post.uuid`.",
    select: {
      columns: { url: true },
    },
    resolve: (post) => post.url ? new URL(post.url) : null,
  }),
  published: t.expose("published", {
    type: "DateTime",
    complexity: questionPollComplexity,
  }),
  actor: t.relation("actor", { complexity: questionPollComplexity }),
  quotedPost: t.relation("quotedPost", {
    type: Post,
    nullable: true,
    complexity: questionPollComplexity,
  }),
  sharedPost: t.relation("sharedPost", {
    type: Post,
    nullable: true,
    complexity: questionPollComplexity,
  }),
}));

const Poll = builder.drizzleNode("pollTable", {
  name: "Poll",
  description:
    "A poll attached to a `Question` post. Contains options, vote counts, " +
    "and the voting deadline.",
  id: {
    column: (poll) => poll.postId,
  },
  fields: (t) => ({
    multiple: t.exposeBoolean("multiple", {
      description:
        "Whether voters may select more than one option. When `false`, " +
        "each voter may choose exactly one option.",
    }),
    ends: t.expose("ends", {
      type: "DateTime",
      description:
        "When voting closes. Votes submitted after this time are rejected.",
    }),
    closed: t.boolean({
      description: "Whether the voting period has ended (`ends <= now()`).",
      select: {
        columns: {
          ends: true,
        },
      },
      resolve(poll) {
        return poll.ends <= new Date();
      },
    }),
    viewerHasVoted: t.boolean({
      description:
        "Whether the authenticated viewer has cast at least one vote in " +
        "this poll. Always `false` for unauthenticated requests.",
      select: {
        columns: {
          postId: true,
        },
      },
      async resolve(poll, _, ctx) {
        return (await getViewerPollOptionIndices(ctx, poll.postId)).size > 0;
      },
    }),
    post: t.relation("post", {
      type: Post,
      description: "The `Question` post this poll belongs to.",
    }),
    options: t.field({
      type: [PollOption],
      description: "The poll's voting options, ordered by their display index.",
      complexity: pollBranchComplexity,
      select: (_, __, nestedSelect) => {
        const selection = nestedSelect();
        return {
          with: {
            options: {
              ...(typeof selection === "object" ? selection : {}),
              orderBy: (table, { asc }) => [asc(table.index)],
            },
          },
        };
      },
      resolve(poll) {
        return poll.options.toSorted((a, b) => a.index - b.index);
      },
    }),
    votes: t.connection({
      type: PollVote,
      description:
        "All votes cast across all options, with the total vote count " +
        "exposed on the connection.",
      complexity: pollBranchComplexity,
      select: (args, ctx, nestedSelect) => ({
        with: {
          votes: pollVoteConnectionHelpers.getQuery(args, ctx, nestedSelect),
        },
        extras: {
          votesCount: (table) =>
            ctx.db.$count(
              pollVoteTable,
              eq(pollVoteTable.postId, table.postId),
            ),
        },
      }),
      resolve(poll, args, ctx) {
        const connection = pollVoteConnectionHelpers.resolve(
          poll.votes,
          args,
          ctx,
          poll,
        );
        return { ...connection, totalCount: poll.votesCount };
      },
    }, {
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
      }),
    }),
    voters: t.connection({
      type: Actor,
      description:
        "Actors who have voted in this poll (deduplicated across options).",
      complexity: pollBranchComplexity,
      select: (args, ctx, nestedSelect) => ({
        with: {
          voters: actorConnectionHelpers.getQuery(args, ctx, nestedSelect),
        },
      }),
      resolve(poll, args, ctx) {
        const connection = actorConnectionHelpers.resolve(
          poll.voters,
          args,
          ctx,
          poll,
        );
        return { ...connection, totalCount: poll.votersCount };
      },
    }, {
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
      }),
    }),
  }),
});

const PollOption = builder.drizzleObject("pollOptionTable", {
  name: "PollOption",
  description: "A single choice in a `Poll`.",
  fields: (t) => ({
    index: t.exposeInt("index", {
      description: "Zero-based display order index for this option.",
    }),
    title: t.exposeString("title"),
    poll: t.relation("poll", {
      description: "The poll this option belongs to.",
    }),
    viewerHasVoted: t.boolean({
      description:
        "Whether the authenticated viewer voted for this specific option. " +
        "Always `false` for unauthenticated requests.",
      select: {
        columns: {
          postId: true,
          index: true,
        },
      },
      async resolve(option, _, ctx) {
        return (await getViewerPollOptionIndices(ctx, option.postId)).has(
          option.index,
        );
      },
    }),
    votes: t.connection({
      type: PollVote,
      complexity: pollBranchComplexity,
      select: (args, ctx, nestedSelect) => ({
        with: {
          votes: pollVoteConnectionHelpers.getQuery(args, ctx, nestedSelect),
        },
      }),
      resolve(option, args, ctx) {
        const connection = pollVoteConnectionHelpers.resolve(
          option.votes,
          args,
          ctx,
          option,
        );
        return { ...connection, totalCount: option.votesCount };
      },
    }, {
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
      }),
    }),
  }),
});

const PollVote = builder.drizzleObject("pollVoteTable", {
  name: "PollVote",
  fields: (t) => ({
    created: t.expose("created", { type: "DateTime" }),
    poll: t.relation("poll"),
    option: t.relation("option"),
    actor: t.relation("actor"),
  }),
});

const pollVoteConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "pollVoteTable",
  {},
);

const actorConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "actorTable",
  {},
);

async function getViewerPollOptionIndices(
  ctx: UserContext,
  postId: Uuid,
): Promise<ReadonlySet<number>> {
  if (ctx.account == null) return new Set();

  ctx.pollViewerVotes ??= new Map();
  const cached = ctx.pollViewerVotes.get(postId);
  if (cached != null) return await cached;

  const promise = ctx.db.query.pollVoteTable.findMany({
    where: {
      postId,
      actorId: ctx.account.actor.id,
    },
    columns: {
      optionIndex: true,
    },
  }).then((votes) =>
    new Set(votes.map((vote) => vote.optionIndex)) as ReadonlySet<number>
  );
  ctx.pollViewerVotes.set(postId, promise);
  return await promise;
}

builder.drizzleObjectField(Question, "poll", (t) =>
  t.field({
    type: Poll,
    nullable: true,
    complexity: questionPollComplexity,
    select: (_, __, nestedSelect) => ({
      columns: {
        id: true,
        iri: true,
        sharedPostId: true,
      },
      with: {
        poll: nestedSelect(),
      },
    }),
    async resolve(question, _, ctx) {
      if (question.poll != null) return question.poll;
      if (question.sharedPostId != null) return null;

      // Guests must not trigger federation lookups: they would let
      // unauthenticated callers spawn outbound fetches and persist remote
      // poll subobjects on demand.
      if (ctx.account == null) return null;

      try {
        const documentLoader = await ctx.fedCtx.getDocumentLoader({
          identifier: ctx.account.id,
        });
        const postObject = await ctx.fedCtx.lookupObject(question.iri, {
          documentLoader,
        });
        if (!(postObject instanceof vocab.Question)) return null;

        await persistPost(ctx.fedCtx, postObject, { documentLoader });
      } catch {
        return null;
      }
      const reloaded = await ctx.db.query.postTable.findFirst({
        where: {
          id: question.id,
          type: "Question",
        },
        with: {
          poll: {
            extras: {
              votesCount: (table) =>
                ctx.db.$count(
                  pollVoteTable,
                  eq(pollVoteTable.postId, table.postId),
                ),
            },
            with: {
              options: {
                orderBy: (table, { asc }) => [asc(table.index)],
                with: {
                  votes: true,
                },
              },
              votes: true,
              voters: true,
            },
          },
        },
      });
      return reloaded?.poll ?? null;
    },
  }));

builder.relayMutationField(
  "voteOnPoll",
  {
    inputFields: (t) => ({
      questionId: t.globalID({
        for: [Question],
        required: true,
      }),
      optionIndices: t.intList({ required: true }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const optionIndices = new Set(args.input.optionIndices);
      if (optionIndices.size !== args.input.optionIndices.length) {
        throw new InvalidInputError("optionIndices");
      }
      if (optionIndices.size < 1) {
        throw new InvalidInputError("optionIndices");
      }

      const question = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          mentions: true,
          poll: {
            with: {
              options: {
                orderBy: (table, { asc }) => [asc(table.index)],
                with: {
                  votes: true,
                },
              },
              votes: true,
              voters: true,
            },
          },
        },
        where: {
          id: args.input.questionId.id,
          type: "Question",
        },
      });

      if (
        question == null || question.poll == null ||
        !isPostVisibleTo(question, ctx.account.actor)
      ) {
        throw new InvalidInputError("questionId");
      }

      if (question.poll.ends <= new Date()) {
        throw new InvalidInputError("questionId");
      }

      if (!question.poll.multiple && optionIndices.size !== 1) {
        throw new InvalidInputError("optionIndices");
      }

      const validOptionIndices = new Set(
        question.poll.options.map((option) => option.index),
      );
      if (
        [...optionIndices].some((index) => !validOptionIndices.has(index))
      ) {
        throw new InvalidInputError("optionIndices");
      }

      const persistedVotes = await vote(
        ctx.fedCtx,
        ctx.account,
        question.poll,
        optionIndices,
      );
      if (persistedVotes.length < 1) {
        throw new InvalidInputError("questionId");
      }

      const updatedPoll = await ctx.db.query.pollTable.findFirst({
        extras: {
          votesCount: (table) =>
            ctx.db.$count(
              pollVoteTable,
              eq(pollVoteTable.postId, table.postId),
            ),
        },
        with: {
          options: {
            orderBy: (table, { asc }) => [asc(table.index)],
            with: {
              votes: true,
            },
          },
          votes: true,
          voters: true,
        },
        where: {
          postId: question.id,
        },
      });
      if (updatedPoll == null) {
        throw new InvalidInputError("questionId");
      }

      const votes = persistedVotes
        .toSorted((a, b) => a.optionIndex - b.optionIndex)
        .map((pollVote) => {
          const option = updatedPoll.options.find((option) =>
            option.index === pollVote.optionIndex
          );
          if (option == null) {
            throw new InvalidInputError("optionIndices");
          }
          return { ...pollVote, option };
        });

      const updatedQuestion = { ...question, poll: updatedPoll };

      return { question: updatedQuestion, poll: updatedPoll, votes };
    },
  },
  {
    outputFields: (t) => ({
      question: t.field({
        type: Question,
        resolve(result) {
          return result.question;
        },
      }),
      poll: t.field({
        type: Poll,
        resolve(result) {
          return result.poll;
        },
      }),
      votes: t.field({
        type: [PollVote],
        resolve(result) {
          return result.votes;
        },
      }),
    }),
  },
);
