import {
  type BookmarkCursor,
  type BookmarkEntry,
  getBookmarks,
} from "@hackerspub/models/bookmark";
import {
  OrganizationPermissionError,
  resolveActingAccount,
} from "@hackerspub/models/organization";
import {
  formatTimelineCursor,
  getPersonalTimeline,
  getPublicTimeline,
  parseTimelineCursor,
  type TimelineCursor,
} from "@hackerspub/models/timeline";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { assertNever } from "@std/assert/unstable-never";
import { createGraphQLError } from "graphql-yoga";
import { Account as AccountRef } from "./account.ts";
import { Actor } from "./actor.ts";
import { builder, type UserContext } from "./builder.ts";
import { Post, PostType } from "./post.ts";

const MAX_TIMELINE_WINDOW = 250;
const MAX_LANGUAGE_FILTERS = 20;

// `Authentication required` is intentional — return as a real
// `GraphQLError` so Yoga doesn't fold it into a generic
// "Unexpected error." (which obscures the cause and forces clients to
// pattern-match on a message they can't trust) and so `useSentry()`'s
// default `isOriginalGraphQLError` skipError filter doesn't report it
// as an unhandled exception. The `AUTHENTICATION_REQUIRED` extension
// code lets clients filter these out of their own Sentry captures
// without string-matching the message.
function authenticationRequired(): never {
  throw createGraphQLError("Authentication required.", {
    extensions: { code: "AUTHENTICATION_REQUIRED" },
  });
}

async function resolvePersonalTimelineAccount(
  ctx: UserContext,
  actingAccountId?: { id: string } | null,
): Promise<Awaited<ReturnType<typeof resolveActingAccount>>> {
  if (ctx.account == null) authenticationRequired();
  const rawAccountId = actingAccountId?.id;
  if (rawAccountId != null && !validateUuid(rawAccountId)) {
    throw createGraphQLError("Invalid acting account.", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  try {
    return await resolveActingAccount(
      ctx.db,
      ctx.account,
      rawAccountId as Uuid | undefined,
    );
  } catch (error) {
    if (error instanceof OrganizationPermissionError) {
      throw createGraphQLError("Not allowed to read this account's feed.", {
        originalError: error,
        extensions: { code: "FORBIDDEN" },
      });
    }
    throw error;
  }
}

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

function parseRequiredBookmarkCursor(raw: string): BookmarkCursor {
  const cursor = parseBookmarkCursor(raw);
  if (cursor == null) {
    throw createGraphQLError("Invalid bookmark cursor.", {
      extensions: { code: "INVALID_CURSOR" },
    });
  }
  return cursor;
}

function parseRequiredTimelineCursor(raw: string): TimelineCursor {
  const cursor = parseTimelineCursor(raw);
  if (cursor == null) {
    throw createGraphQLError("Invalid timeline cursor.", {
      extensions: { code: "INVALID_CURSOR" },
    });
  }
  return cursor;
}

function formatBookmarkCursor(entry: BookmarkEntry): string {
  return `${entry.bookmarked.toISOString()}|${entry.post.id}`;
}

function getConnectionWindow(
  args: { first?: number | null; last?: number | null },
  options: { maxWindow?: number } = {},
): number {
  if (args.first != null && args.last != null) {
    throw createGraphQLError("Cannot paginate with both first and last.", {
      extensions: { code: "PAGINATION_ERROR" },
    });
  }
  const window = args.last ?? args.first ?? 25;
  if (options.maxWindow != null && window > options.maxWindow) {
    throw createGraphQLError(
      `Timeline pages are limited to ${options.maxWindow} posts.`,
      { extensions: { code: "PAGINATION_ERROR" } },
    );
  }
  return window;
}

function conflictingCursors(): never {
  throw createGraphQLError("Cannot paginate with both after and before.", {
    extensions: { code: "PAGINATION_ERROR" },
  });
}

function getConnectionPage<T>(
  entries: readonly T[],
  window: number,
  backwards: boolean,
): T[] {
  const page = entries.slice(0, window);
  return backwards ? [...page].reverse() : page;
}

builder.queryFields((t) => ({
  publicTimeline: t.connection(
    {
      type: Post,
      description:
        `All public posts from all known instances, newest first. ` +
        `Accessible without authentication. Pagination window ` +
        `(\`first\`/\`last\`) is capped at ${MAX_TIMELINE_WINDOW} posts. ` +
        `Use \`languages\` to filter by language, \`local\` to restrict ` +
        `to this instance only, and \`withoutShares\` to hide boost wrappers.`,
      args: {
        languages: t.arg({
          type: ["Locale"],
          defaultValue: [],
          description:
            'Filter by base language code. Passing `"en"` returns posts ' +
            'with `language = "en"` or any `"en-*"` variant. Region-' +
            'specific tags such as `"en-US"` are normalized to their base ' +
            "language and match all variants. At most " +
            `${MAX_LANGUAGE_FILTERS} codes are accepted; passing more ` +
            "raises a `TOO_MANY_LANGUAGE_FILTERS` error.",
        }),
        local: t.arg.boolean({ defaultValue: false }),
        withoutShares: t.arg.boolean({ defaultValue: false }),
        postType: t.arg({
          type: PostType,
          required: false,
        }),
      },
      async resolve(_, args, ctx) {
        if (args.after != null && args.before != null) {
          conflictingCursors();
        }
        if ((args.languages?.length ?? 0) > MAX_LANGUAGE_FILTERS) {
          throw createGraphQLError(
            `Too many language filters: at most ${MAX_LANGUAGE_FILTERS} ` +
              "base language codes are accepted.",
            { extensions: { code: "TOO_MANY_LANGUAGE_FILTERS" } },
          );
        }
        const backwards = args.last != null;
        const window = getConnectionWindow(args, {
          maxWindow: MAX_TIMELINE_WINDOW,
        });
        const since =
          args.before == null
            ? undefined
            : parseRequiredTimelineCursor(args.before);
        const until =
          args.after == null
            ? undefined
            : parseRequiredTimelineCursor(args.after);
        const timeline = await getPublicTimeline(ctx.db, {
          currentAccount: ctx.account,
          direction: backwards ? "backward" : "forward",
          languages: new Set(
            (args.languages ?? []).flatMap((l) =>
              l.language ? [l.language] : [],
            ),
          ),
          local: args.local ?? false,
          withoutShares: args.withoutShares ?? false,
          postType:
            args.postType == null
              ? undefined
              : args.postType === "ARTICLE"
                ? "Article"
                : args.postType === "NOTE"
                  ? "Note"
                  : args.postType === "QUESTION"
                    ? "Question"
                    : assertNever(args.postType),
          window: window + 1,
          since,
          until,
        });
        const pageEntries = getConnectionPage(timeline, window, backwards);
        return {
          pageInfo: {
            hasNextPage: backwards
              ? args.before != null && timeline.length > window
              : timeline.length > window,
            hasPreviousPage: backwards
              ? timeline.length > window
              : args.after != null,
            startCursor:
              pageEntries.length < 1
                ? null
                : formatTimelineCursor(pageEntries[0]),
            endCursor:
              pageEntries.length < 1
                ? null
                : formatTimelineCursor(pageEntries[pageEntries.length - 1]),
          },
          edges: pageEntries.map(
            ({ post, lastSharer, sharersCount, added, cursor }) => ({
              node: post,
              cursor: formatTimelineCursor({ post, cursor }),
              lastSharer,
              sharersCount,
              added,
            }),
          ),
        };
      },
    },
    {},
    {
      fields: (te) => ({
        lastSharer: te.expose("lastSharer", {
          type: Actor,
          nullable: true,
          description:
            "The most recent account the viewer follows that boosted this " +
            "post into the timeline, if the post reached the viewer via a boost.",
        }),
        sharersCount: te.exposeInt("sharersCount", {
          description:
            "Number of accounts the viewer follows that have boosted this " +
            "post. Useful for 'N people you follow shared this' display.",
        }),
        added: te.expose("added", {
          type: "DateTime",
          description:
            "When this post was added to the timeline: either its " +
            "publication time or when it was most recently boosted into the feed.",
        }),
      }),
    },
  ),

  bookmarks: t.connection({
    type: Post,
    description:
      "The authenticated viewer's bookmarked posts, newest-bookmarked " +
      "first. Throws `AUTHENTICATION_REQUIRED` when called without a session.",
    args: {
      postType: t.arg({
        type: PostType,
        required: false,
      }),
    },
    async resolve(_, args, ctx) {
      if (ctx.account == null) {
        authenticationRequired();
      } else if (args.after != null && args.before != null) {
        conflictingCursors();
      }
      const backwards = args.last != null;
      const window = getConnectionWindow(args);
      const since =
        args.before == null
          ? undefined
          : parseRequiredBookmarkCursor(args.before);
      const until =
        args.after == null
          ? undefined
          : parseRequiredBookmarkCursor(args.after);
      const bookmarks = await getBookmarks(ctx.db, {
        account: ctx.account,
        direction: backwards ? "backward" : "forward",
        postType:
          args.postType == null
            ? undefined
            : args.postType === "ARTICLE"
              ? "Article"
              : args.postType === "NOTE"
                ? "Note"
                : args.postType === "QUESTION"
                  ? "Question"
                  : assertNever(args.postType),
        window: window + 1,
        since,
        until,
      });
      const pageEntries = getConnectionPage(bookmarks, window, backwards);
      return {
        pageInfo: {
          hasNextPage: backwards
            ? args.before != null && bookmarks.length > window
            : bookmarks.length > window,
          hasPreviousPage: backwards
            ? bookmarks.length > window
            : args.after != null,
          startCursor:
            pageEntries.length < 1
              ? null
              : formatBookmarkCursor(pageEntries[0]),
          endCursor:
            pageEntries.length < 1
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
      description:
        `Posts from accounts the authenticated viewer follows, newest first. ` +
        `Throws \`AUTHENTICATION_REQUIRED\` when called without a session. ` +
        `Pagination window (\`first\`/\`last\`) is capped at ` +
        `${MAX_TIMELINE_WINDOW} posts. Use \`languages\` to filter by ` +
        `language (a base code like \`"en"\` matches \`"en"\` and all ` +
        `\`"en-*"\` variants), \`local\` to restrict to this instance only, ` +
        `and \`withoutShares\` to hide boost wrappers. Pass ` +
        `\`actingAccountId\` to read an organization account's feed when ` +
        `the viewer is an accepted member.`,
      args: {
        actingAccountId: t.arg.globalID({
          for: AccountRef,
          required: false,
          description:
            "Optional `Account` id whose feed should be read instead of " +
            "the viewer's personal account. Only accepted organization " +
            "members can read an organization's feed this way.",
        }),
        languages: t.arg({
          type: ["Locale"],
          defaultValue: [],
          description:
            'Filter by base language code. Passing `"en"` returns posts ' +
            'with `language = "en"` or any `"en-*"` variant. Region-' +
            'specific tags such as `"en-US"` are normalized to their base ' +
            "language and match all variants. At most " +
            `${MAX_LANGUAGE_FILTERS} codes are accepted; passing more ` +
            "raises a `TOO_MANY_LANGUAGE_FILTERS` error.",
        }),
        local: t.arg.boolean({ defaultValue: false }),
        withoutShares: t.arg.boolean({ defaultValue: false }),
        postType: t.arg({
          type: PostType,
          required: false,
        }),
      },
      async resolve(_, args, ctx) {
        if (ctx.account == null) {
          authenticationRequired();
        } else if (args.after != null && args.before != null) {
          conflictingCursors();
        }
        if ((args.languages?.length ?? 0) > MAX_LANGUAGE_FILTERS) {
          throw createGraphQLError(
            `Too many language filters: at most ${MAX_LANGUAGE_FILTERS} ` +
              "base language codes are accepted.",
            { extensions: { code: "TOO_MANY_LANGUAGE_FILTERS" } },
          );
        }
        const backwards = args.last != null;
        const window = getConnectionWindow(args, {
          maxWindow: MAX_TIMELINE_WINDOW,
        });
        const since =
          args.before == null
            ? undefined
            : parseRequiredTimelineCursor(args.before);
        const until =
          args.after == null
            ? undefined
            : parseRequiredTimelineCursor(args.after);
        const timelineAccount = await resolvePersonalTimelineAccount(
          ctx,
          args.actingAccountId,
        );
        const timeline = await getPersonalTimeline(ctx.db, {
          currentAccount: timelineAccount,
          direction: backwards ? "backward" : "forward",
          languages: new Set(
            (args.languages ?? []).flatMap((l) =>
              l.language ? [l.language] : [],
            ),
          ),
          local: args.local ?? false,
          withoutShares: args.withoutShares ?? false,
          postType:
            args.postType == null
              ? undefined
              : args.postType === "ARTICLE"
                ? "Article"
                : args.postType === "NOTE"
                  ? "Note"
                  : args.postType === "QUESTION"
                    ? "Question"
                    : assertNever(args.postType),
          window: window + 1,
          since,
          until,
        });
        const pageEntries = getConnectionPage(timeline, window, backwards);
        return {
          pageInfo: {
            hasNextPage: backwards
              ? args.before != null && timeline.length > window
              : timeline.length > window,
            hasPreviousPage: backwards
              ? timeline.length > window
              : args.after != null,
            startCursor:
              pageEntries.length < 1
                ? null
                : formatTimelineCursor(pageEntries[0]),
            endCursor:
              pageEntries.length < 1
                ? null
                : formatTimelineCursor(pageEntries[pageEntries.length - 1]),
          },
          edges: pageEntries.map(
            ({ post, lastSharer, sharersCount, added, cursor }) => ({
              node: post,
              cursor: formatTimelineCursor({ post, cursor }),
              lastSharer,
              sharersCount,
              added,
            }),
          ),
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
