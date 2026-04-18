import { getBookmarks } from "@hackerspub/models/bookmark";
import {
  getPersonalTimeline,
  getPublicTimeline,
} from "@hackerspub/models/timeline";
import { assertNever } from "@std/assert/unstable-never";
import { Actor } from "./actor.ts";
import { builder } from "./builder.ts";
import { Post, PostType } from "./post.ts";

builder.queryFields((t) => ({
  publicTimeline: t.connection(
    {
      type: Post,
      args: {
        languages: t.arg({
          type: ["Locale"],
          defaultValue: [],
        }),
        local: t.arg.boolean({ defaultValue: false }),
        withoutShares: t.arg.boolean({ defaultValue: false }),
        postType: t.arg({
          type: PostType,
          required: false,
        }),
      },
      async resolve(_, args, ctx) {
        if (args.last != null || args.before != null) {
          throw new Error("Backward pagination is not supported.");
        }
        const window = args.first ?? 25;
        const until = args.after == null ? undefined : new Date(args.after);
        const timeline = await getPublicTimeline(ctx.db, {
          currentAccount: ctx.account,
          languages: new Set((args.languages ?? []).map((l) => l.baseName)),
          local: args.local ?? false,
          withoutShares: args.withoutShares ?? false,
          postType: args.postType == null
            ? undefined
            : args.postType === "ARTICLE"
            ? "Article"
            : args.postType === "NOTE"
            ? "Note"
            : args.postType === "QUESTION"
            ? "Question"
            : assertNever(args.postType),
          window: window + 1,
          until,
        });
        return {
          pageInfo: {
            hasNextPage: timeline.length > window,
            hasPreviousPage: false,
            startCursor: timeline.length < 2
              ? null
              : timeline[1].added.toISOString(),
            endCursor: timeline.length < 2
              ? null
              : timeline.at(-1)!.added.toISOString(),
          },
          edges: timeline.slice(0, window).map((
            { post, lastSharer, sharersCount, added },
            i,
          ) => ({
            node: post,
            cursor: timeline[i + 1]?.added?.toISOString() ?? "",
            lastSharer,
            sharersCount,
            added,
          })),
        };
      },
    },
    {},
    {
      fields: (te) => ({
        lastSharer: te.expose("lastSharer", { type: Actor, nullable: true }),
        sharersCount: te.exposeInt("sharersCount"),
        added: te.expose("added", { type: "DateTime" }),
      }),
    },
  ),

  bookmarks: t.connection({
    type: Post,
    args: {
      postType: t.arg({
        type: PostType,
        required: false,
      }),
    },
    async resolve(_, args, ctx) {
      if (ctx.account == null) {
        throw new Error("Authentication required.");
      } else if (args.last != null || args.before != null) {
        throw new Error("Backward pagination is not supported.");
      }
      const window = args.first ?? 25;
      const until = args.after == null ? undefined : new Date(args.after);
      const bookmarks = await getBookmarks(ctx.db, {
        account: ctx.account,
        postType: args.postType == null
          ? undefined
          : args.postType === "ARTICLE"
          ? "Article"
          : args.postType === "NOTE"
          ? "Note"
          : args.postType === "QUESTION"
          ? "Question"
          : assertNever(args.postType),
        window: window + 1,
        until,
      });
      return {
        pageInfo: {
          hasNextPage: bookmarks.length > window,
          hasPreviousPage: false,
          startCursor: bookmarks.length < 2
            ? null
            : bookmarks[1].bookmarkedAt.toISOString(),
          endCursor: bookmarks.length < 2
            ? null
            : bookmarks.at(-1)!.bookmarkedAt.toISOString(),
        },
        edges: bookmarks.slice(0, window).map((entry, i) => ({
          node: entry.post,
          cursor: bookmarks[i + 1]?.bookmarkedAt?.toISOString() ?? "",
        })),
      };
    },
  }),

  personalTimeline: t.connection(
    {
      type: Post,
      args: {
        local: t.arg.boolean({ defaultValue: false }),
        withoutShares: t.arg.boolean({ defaultValue: false }),
        postType: t.arg({
          type: PostType,
          required: false,
        }),
      },
      async resolve(_, args, ctx) {
        if (ctx.account == null) {
          throw new Error("Authentication required.");
        } else if (args.last != null || args.before != null) {
          throw new Error("Backward pagination is not supported.");
        }
        const window = args.first ?? 25;
        const until = args.after == null ? undefined : new Date(args.after);
        const timeline = await getPersonalTimeline(ctx.db, {
          currentAccount: ctx.account,
          local: args.local ?? false,
          withoutShares: args.withoutShares ?? false,
          postType: args.postType == null
            ? undefined
            : args.postType === "ARTICLE"
            ? "Article"
            : args.postType === "NOTE"
            ? "Note"
            : args.postType === "QUESTION"
            ? "Question"
            : assertNever(args.postType),
          window: window + 1,
          until,
        });
        return {
          pageInfo: {
            hasNextPage: timeline.length > window,
            hasPreviousPage: false,
            startCursor: timeline.length < 2
              ? null
              : timeline[1].added.toISOString(),
            endCursor: timeline.length < 2
              ? null
              : timeline.at(-1)!.added.toISOString(),
          },
          edges: timeline.slice(0, window).map((
            { post, lastSharer, sharersCount, added },
            i,
          ) => ({
            node: post,
            cursor: timeline[i + 1]?.added?.toISOString() ?? "",
            lastSharer,
            sharersCount,
            added,
          })),
        };
      },
    },
    {},
    {
      fields: (te) => ({
        lastSharer: te.expose("lastSharer", { type: Actor, nullable: true }),
        sharersCount: te.exposeInt("sharersCount"),
        added: te.expose("added", { type: "DateTime" }),
      }),
    },
  ),
}));
