import { isActor } from "@fedify/vocab";
import { persistActor } from "@hackerspub/models/actor";
import { isPostObject } from "@hackerspub/models/post/core";
import { persistPost } from "@hackerspub/models/post/remote";
import type { Uuid } from "@hackerspub/models/uuid";
import { Actor } from "./actor.ts";
import { builder } from "./builder.ts";
import { InvalidInputError, NotAuthorizedError } from "./error.ts";
import { Post } from "./post.ts";
import { NotAuthenticatedError } from "./session.ts";

interface RefreshRemoteObjectResult {
  actorId: Uuid | null;
  postId: Uuid | null;
}

builder.relayMutationField(
  "refreshRemoteObject",
  {
    description:
      "Force a re-fetch of a remote actor or post from its origin server and " +
      "overwrite the cached copy, for when the local copy is stale or broken " +
      "(a renamed profile, an edited post, a missing avatar). Requires a " +
      "moderator account. The fetched object only: it does not pull the " +
      "actor's outbox or the post's reply tree.",
    inputFields: (t) => ({
      uri: t.string({
        required: true,
        description:
          "The object to refresh, given as its ActivityPub IRI, an HTTP URL, " +
          "or a `@user@host` handle. Resolved via the same federation lookup " +
          "as `searchObject`. Must point to a remote object: refreshing a " +
          "local actor or post raises `InvalidInputError`.",
      }),
    }),
  },
  {
    description:
      "Re-fetch a remote actor or post and overwrite its cached row. " +
      "Moderator-only; raises `NotAuthenticatedError` for guests, " +
      "`NotAuthorizedError` for non-moderators, and `InvalidInputError` when " +
      "the URI cannot be resolved, resolves to neither an actor nor a post, " +
      "or points at a local object.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
      union: {
        description:
          "Result of refreshing a remote object: the refreshed actor or post " +
          "on success, or a typed error.",
      },
    },
    async resolve(_root, args, ctx): Promise<RefreshRemoteObjectResult> {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const documentLoader = await ctx.fedCtx.getDocumentLoader({
        identifier: ctx.account.id,
      });
      let object;
      try {
        object = await ctx.fedCtx.lookupObject(args.input.uri, {
          documentLoader,
        });
      } catch {
        throw new InvalidInputError("uri");
      }
      if (object?.id == null) throw new InvalidInputError("uri");
      // A local object has no remote origin to refresh from.
      if (object.id.origin === new URL(ctx.fedCtx.canonicalOrigin).origin) {
        throw new InvalidInputError("uri");
      }
      if (isActor(object)) {
        const persisted = await persistActor(ctx.fedCtx, object, {
          contextLoader: ctx.fedCtx.contextLoader,
          documentLoader,
          outbox: false,
        });
        if (persisted == null) throw new InvalidInputError("uri");
        return { actorId: persisted.id, postId: null };
      }
      if (isPostObject(object)) {
        const persisted = await persistPost(ctx.fedCtx, object, {
          contextLoader: ctx.fedCtx.contextLoader,
          documentLoader,
        });
        if (persisted == null) throw new InvalidInputError("uri");
        return { actorId: null, postId: persisted.id };
      }
      throw new InvalidInputError("uri");
    },
  },
  {
    description:
      "The refreshed object. Exactly one of `actor` or `post` is non-`null`, " +
      "matching whichever kind the URI resolved to.",
    outputFields: (t) => ({
      actor: t.drizzleField({
        type: Actor,
        nullable: true,
        description:
          "The refreshed remote actor, or `null` when the URI resolved to a " +
          "post.",
        async resolve(query, result, _args, ctx) {
          if (result.actorId == null) return null;
          return await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.actorId } }),
          );
        },
      }),
      post: t.drizzleField({
        type: Post,
        nullable: true,
        description:
          "The refreshed remote post, or `null` when the URI resolved to an " +
          "actor.",
        async resolve(query, result, _args, ctx) {
          if (result.postId == null) return null;
          return await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.postId } }),
          );
        },
      }),
    }),
  },
);
