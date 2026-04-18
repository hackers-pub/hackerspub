import { createFlag } from "@hackerspub/models/flag";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { builder } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { Article, Note, Post, Question } from "./post.ts";
import { NotAuthenticatedError } from "./session.ts";

export class AlreadyReportedError extends Error {
  public constructor() {
    super("You have already reported this post");
  }
}

builder.objectType(AlreadyReportedError, {
  name: "AlreadyReportedError",
  fields: (t) => ({
    message: t.string({
      resolve: () => "You have already reported this post",
    }),
  }),
});

builder.relayMutationField(
  "reportPost",
  {
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      reason: t.string({ required: true }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError, AlreadyReportedError],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const post = await ctx.db.query.postTable.findFirst({
        columns: { id: true, actorId: true },
        where: { id: args.input.postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (post.actorId === ctx.account.actor.id) {
        throw new InvalidInputError("postId");
      }

      const flagId = generateUuidV7();
      const iri = new URL(
        `#flags/${post.id}/${flagId}`,
        ctx.fedCtx.getActorUri(ctx.account.id),
      ).href;

      const result = await createFlag(
        ctx.db,
        flagId,
        iri,
        ctx.account.actor.id,
        post.id,
        args.input.reason,
      );

      if (!result.created) {
        throw new AlreadyReportedError();
      }

      return { postId: post.id };
    },
  },
  {
    outputFields: (t) => ({
      post: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.postId } }),
          );
          return post!;
        },
      }),
    }),
  },
);
