import { assert } from "@std/assert";
import {
  followHashtag,
  getPinnedHashtags,
  isFollowingHashtag,
  normalizeHashtag,
  pinHashtag,
  unfollowHashtag,
  unpinHashtag,
  validateHashtag,
} from "@hackerspub/models/hashtag";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

builder.drizzleObjectField(Account, "followsHashtag", (t) =>
  t.boolean({
    description:
      "Whether the viewer follows the given hashtag. Always `false` for " +
      "unauthenticated requests or when the account is not the viewer.",
    args: {
      tag: t.arg.string({
        required: true,
        description: "Hashtag name without the leading `#`.",
      }),
    },
    select: { columns: { id: true } },
    async resolve(account, args, ctx) {
      if (ctx.account?.id !== account.id) return false;
      const tag = normalizeHashtag(args.tag);
      if (tag === "") return false;
      return isFollowingHashtag(ctx.db, account.id, tag);
    },
  }));

builder.drizzleObjectField(Account, "pinnedHashtags", (t) =>
  t.stringList({
    description:
      "Hashtags the viewer has pinned to their sidebar, in follow order. " +
      "Returns an empty list for unauthenticated requests or when the " +
      "account is not the viewer.",
    select: { columns: { id: true } },
    async resolve(account, _args, ctx) {
      if (ctx.account?.id !== account.id) return [];
      return getPinnedHashtags(ctx.db, account.id);
    },
  }));

builder.relayMutationField(
  "followHashtag",
  {
    description: "Follow a hashtag. Requires authentication.",
    inputFields: (t) => ({
      tag: t.string({
        required: true,
        description: "Hashtag name to follow (with or without leading `#`).",
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      if (!validateHashtag(args.input.tag)) throw new InvalidInputError("tag");
      const tag = normalizeHashtag(args.input.tag);
      await followHashtag(ctx.db, ctx.account.id, tag);
      return { accountId: ctx.account.id, tag };
    },
  },
  {
    outputFields: (t) => ({
      tag: t.string({
        description: "The normalized hashtag name that was followed.",
        resolve: (result) => result.tag,
      }),
      viewer: t.drizzleField({
        type: Account,
        description: "The authenticated viewer's account after following.",
        async resolve(query, result, _args, ctx) {
          const account = await ctx.db.query.accountTable.findFirst(
            query({ where: { id: result.accountId } }),
          );
          assert(account != undefined);
          return account;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unfollowHashtag",
  {
    description:
      "Unfollow a hashtag. Idempotent: unfollowing a tag not followed " +
      "succeeds silently. Requires authentication.",
    inputFields: (t) => ({
      tag: t.string({
        required: true,
        description: "Hashtag name to unfollow (with or without leading `#`).",
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      if (!validateHashtag(args.input.tag)) throw new InvalidInputError("tag");
      const tag = normalizeHashtag(args.input.tag);
      await unfollowHashtag(ctx.db, ctx.account.id, tag);
      return { accountId: ctx.account.id, tag };
    },
  },
  {
    outputFields: (t) => ({
      tag: t.string({
        description: "The normalized hashtag name that was unfollowed.",
        resolve: (result) => result.tag,
      }),
      viewer: t.drizzleField({
        type: Account,
        description: "The authenticated viewer's account after unfollowing.",
        async resolve(query, result, _args, ctx) {
          const account = await ctx.db.query.accountTable.findFirst(
            query({ where: { id: result.accountId } }),
          );
          assert(account != undefined);
          return account;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "pinHashtag",
  {
    description:
      "Pin a followed hashtag to the sidebar. The hashtag must already be " +
      "followed. Requires authentication.",
    inputFields: (t) => ({
      tag: t.string({
        required: true,
        description: "Hashtag name to pin (with or without leading `#`).",
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      if (!validateHashtag(args.input.tag)) throw new InvalidInputError("tag");
      const tag = normalizeHashtag(args.input.tag);
      const pinned = await pinHashtag(ctx.db, ctx.account.id, tag);
      if (!pinned) throw new InvalidInputError("tag");
      return { accountId: ctx.account.id, tag };
    },
  },
  {
    outputFields: (t) => ({
      tag: t.string({
        description: "The normalized hashtag name that was pinned.",
        resolve: (result) => result.tag,
      }),
      viewer: t.drizzleField({
        type: Account,
        description: "The authenticated viewer's account after pinning.",
        async resolve(query, result, _args, ctx) {
          const account = await ctx.db.query.accountTable.findFirst(
            query({ where: { id: result.accountId } }),
          );
          assert(account != undefined);
          return account;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unpinHashtag",
  {
    description:
      "Remove a hashtag from the sidebar. Idempotent: unpinning an " +
      "already-unpinned tag succeeds silently. Requires authentication.",
    inputFields: (t) => ({
      tag: t.string({
        required: true,
        description: "Hashtag name to unpin (with or without leading `#`).",
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      if (!validateHashtag(args.input.tag)) throw new InvalidInputError("tag");
      const tag = normalizeHashtag(args.input.tag);
      await unpinHashtag(ctx.db, ctx.account.id, tag);
      return { accountId: ctx.account.id, tag };
    },
  },
  {
    outputFields: (t) => ({
      tag: t.string({
        description: "The normalized hashtag name that was unpinned.",
        resolve: (result) => result.tag,
      }),
      viewer: t.drizzleField({
        type: Account,
        description: "The authenticated viewer's account after unpinning.",
        async resolve(query, result, _args, ctx) {
          const account = await ctx.db.query.accountTable.findFirst(
            query({ where: { id: result.accountId } }),
          );
          assert(account != undefined);
          return account;
        },
      }),
    }),
  },
);
