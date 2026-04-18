import {
  type BookmarkCursor,
  type BookmarkEntry,
  getBookmarks,
} from "@hackerspub/models/bookmark";
import {
  getPersonalTimeline,
  getPublicTimeline,
} from "@hackerspub/models/timeline";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { assertNever } from "@std/assert/unstable-never";
import { Actor } from "./actor.ts";
import { builder } from "./builder.ts";
import { Post, PostType } from "./post.ts";

function parseBookmarkCursor(raw: string): BookmarkCursor | undefined {
  const i = raw.indexOf("|");
  if (i < 0) return undefined;
  const iso = raw.slice(0, i);
  const postId = raw.slice(i + 1);
  const created = new Date(iso);
  if (isNaN(created.getTime())) return undefined;
  if (!validateUuid(postId)) return undefined;
  return { created, postId: postId as Uuid };
}

function formatBookmarkCursor(entry: BookmarkEntry): string {
  return `${entry.bookmarked.toISOString()}|${entry.post.id}`;
}

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
      const until = args.after == null
        ? undefined
        : parseBookmarkCursor(args.after);
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
      const pageEntries = bookmarks.slice(0, window);
      return {
        pageInfo: {
          hasNextPage: bookmarks.length > window,
          hasPreviousPage: false,
          startCursor: pageEntries.length < 1
            ? null
            : formatBookmarkCursor(pageEntries[0]),
          endCursor: pageEntries.length < 1
            ? null
            : formatBookmarkCursor(pageEntries[pageEntries.length - 1]),
        },
        edges: pageEntries.map((entry) => ({
          node: entry.post,
          cursor: formatBookmarkCursor(entry),
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
