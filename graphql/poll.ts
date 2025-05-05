import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { pollVoteTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import { builder } from "./builder.ts";
import { Actor } from "./actor.ts";
import { Post } from "./post.ts";

builder.drizzleNode("pollTable", {
  name: "Poll",
  id: {
    column: (poll) => poll.postId,
  },
  fields: (t) => ({
    multiple: t.exposeBoolean("multiple"),
    ends: t.expose("ends", { type: "DateTime" }),
    post: t.relation("post", { type: Post }),
    options: t.field({
      type: [PollOption],
      select: (_, __, nestedSelect) => ({
        with: {
          options: nestedSelect(),
        },
      }),
      resolve(poll) {
        return poll.options.toSorted((a, b) => a.index - b.index);
      },
    }),
    votes: t.connection({
      type: PollVote,
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
        return { totalCount: poll.votesCount, ...connection };
      },
    }, {
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
      }),
    }),
    voters: t.connection({
      type: Actor,
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
        return { totalCount: poll.votersCount, ...connection };
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
  fields: (t) => ({
    title: t.exposeString("title"),
    poll: t.relation("poll"),
    votes: t.connection({
      type: PollVote,
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
        return { totalCount: option.votesCount, ...connection };
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
