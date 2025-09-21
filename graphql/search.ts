import { isActor } from "@fedify/fedify";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import { compileQuery, parseQuery } from "@hackerspub/models/search";
import {
  FULL_HANDLE_REGEXP,
  HANDLE_REGEXP,
} from "@hackerspub/models/searchPatterns";
import { sql } from "drizzle-orm";
import { createGraphQLError } from "graphql-yoga";
import { builder, type UserContext } from "./builder.ts";
import { Post } from "./post.ts";

class EmptySearchQueryError extends Error {
  public constructor() {
    super("Query cannot be empty");
  }
}

builder.objectType(EmptySearchQueryError, {
  name: "EmptySearchQueryError",
  fields: (t) => ({
    message: t.expose("message", { type: "String" }),
  }),
});

const SearchedObject = builder.simpleObject("SearchedObject", {
  fields: (t) => ({
    url: t.string(),
  }),
});

async function searchAsUrl(ctx: UserContext, query: string) {
  if (URL.canParse(query)) {
    const url = new URL(query).href;
    let post = await ctx.db.query.postTable.findFirst({
      with: { actor: true },
      where: { OR: [{ iri: url }, { url: url }] },
    });

    if (post == null) {
      // Try to fetch remote post using federation context
      const documentLoader = ctx.account == null
        ? ctx.fedCtx.documentLoader
        : await ctx.fedCtx.getDocumentLoader({
          identifier: ctx.account.id,
        });

      let object;
      try {
        object = await ctx.fedCtx.lookupObject(url, { documentLoader });
      } catch {
        return null;
      }

      const { isPostObject, persistPost } = await import(
        "@hackerspub/models/post"
      );
      if (!isPostObject(object)) {
        return null;
      }

      post = await persistPost(ctx.fedCtx, object, {
        contextLoader: ctx.fedCtx.contextLoader,
        documentLoader,
      });

      if (post == null) {
        return null;
      }

      // Add to posts
      const { addPostToTimeline } = await import(
        "@hackerspub/models/timeline"
      );
      await addPostToTimeline(ctx.db, post);
    }

    let redirectUrl: string;
    if (post.actor.accountId == null) {
      redirectUrl = `/${post.actor.handle}/${post.id}`;
    } else if (post.noteSourceId != null) {
      redirectUrl = `/@${post.actor.username}/${post.noteSourceId}`;
    } else if (post.articleSourceId != null) {
      redirectUrl = post.url ?? post.iri;
    } else {
      return null;
    }

    return { url: redirectUrl };
  }
}

async function searchAsHandle(ctx: UserContext, query: string) {
  if (!HANDLE_REGEXP.test(query) && !FULL_HANDLE_REGEXP.test(query)) {
    return null;
  }

  // Check for local handle
  const match = HANDLE_REGEXP.exec(query);
  if (match) {
    const account = await ctx.db.query.accountTable.findFirst({
      where: { username: match[1].toLowerCase() },
    });
    if (account != null) {
      return { url: `/@${account.username}` };
    }
  }

  // Check for full handle
  const fullMatch = FULL_HANDLE_REGEXP.exec(query);
  if (!fullMatch) {
    return null;
  }

  const origin = `https://${fullMatch[2]}`;
  if (!URL.canParse(origin)) {
    return null;
  }
  const host = new URL(origin).host;

  let actor = await ctx.db.query.actorTable.findFirst({
    where: {
      username: fullMatch[1],
      OR: [
        { instanceHost: host },
        { handleHost: host },
      ],
    },
  });

  if (actor != null) {
    const redirectUrl = actor.accountId == null
      ? `/${actor.handle}`
      : `/@${actor.username}`;
    return { url: redirectUrl };
  }

  // Try to fetch remote actor using federation context
  const documentLoader = ctx.account == null
    ? ctx.fedCtx.documentLoader
    : await ctx.fedCtx.getDocumentLoader({ identifier: ctx.account.id });

  let object;
  try {
    object = await ctx.fedCtx.lookupObject(query, { documentLoader });
  } catch {
    return null;
  }

  if (!isActor(object)) {
    return null;
  }

  const { persistActor } = await import("@hackerspub/models/actor");
  actor = await persistActor(ctx.fedCtx, object!, {
    contextLoader: ctx.fedCtx.contextLoader,
    documentLoader,
    outbox: false,
  });

  if (actor == null) {
    return null;
  }
  return { url: `/${actor.handle}` };
}

builder.queryFields((t) => ({
  searchPost: t.connection({
    type: Post,
    args: {
      query: t.arg.string({ required: true }),
      languages: t.arg({
        type: ["Locale"],
        defaultValue: [],
      }),
    },
    async resolve(_, args, ctx) {
      if (args.last != null || args.before != null) {
        throw createGraphQLError("Backward pagination is not supported");
      }
      const window = args.first ?? 25;
      const until = args.after == null ? undefined : new Date(args.after);
      const query = args.query.trim();
      if (!query) {
        throw createGraphQLError("Query cannot be empty");
      }

      const parsedQuery = parseQuery(query);
      if (!parsedQuery) {
        throw createGraphQLError("Invalid search query format");
      }

      const searchFilter = compileQuery(parsedQuery);
      const signedAccount = ctx.account;

      const languages = args.languages ?? [];

      const posts = await ctx.db.query.postTable.findMany({
        where: {
          AND: [
            searchFilter,
            signedAccount
              ? getPostVisibilityFilter(signedAccount.actor)
              : { visibility: "public" },
            { sharedPostId: { isNull: true } },
            languages.length < 1
              ? (signedAccount?.hideForeignLanguages &&
                  signedAccount.locales != null
                ? { language: { in: signedAccount.locales } }
                : {})
              : { language: { in: [...languages.map((l) => l.baseName)] } },
            until == null ? {} : { published: { lte: until } },
          ],
        },
        with: {
          actor: {
            with: {
              instance: true,
              followers: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { followerId: signedAccount.actor.id },
              },
              blockees: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { blockeeId: signedAccount.actor.id },
              },
              blockers: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { blockerId: signedAccount.actor.id },
              },
            },
          },
          link: { with: { creator: true } },
          mentions: {
            with: { actor: true },
          },
          media: true,
          shares: {
            where: signedAccount == null
              ? { RAW: sql`false` }
              : { actorId: signedAccount.actor.id },
          },
          reactions: {
            where: signedAccount == null
              ? { RAW: sql`false` }
              : { actorId: signedAccount.actor.id },
          },
          replyTarget: {
            with: {
              actor: {
                with: {
                  instance: true,
                  followers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { followerId: signedAccount.actor.id },
                  },
                  blockees: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { blockeeId: signedAccount.actor.id },
                  },
                  blockers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { blockerId: signedAccount.actor.id },
                  },
                },
              },
              link: { with: { creator: true } },
              mentions: {
                with: { actor: true },
              },
              media: true,
            },
          },
          sharedPost: {
            with: {
              actor: {
                with: {
                  instance: true,
                  followers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { followerId: signedAccount.actor.id },
                  },
                  blockees: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { blockeeId: signedAccount.actor.id },
                  },
                  blockers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { blockerId: signedAccount.actor.id },
                  },
                },
              },
              link: { with: { creator: true } },
              mentions: {
                with: { actor: true },
              },
              media: true,
              shares: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { actorId: signedAccount.actor.id },
              },
              reactions: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { actorId: signedAccount.actor.id },
              },
              replyTarget: {
                with: {
                  actor: {
                    with: {
                      instance: true,
                      followers: {
                        where: signedAccount == null
                          ? { RAW: sql`false` }
                          : { followerId: signedAccount.actor.id },
                      },
                      blockees: {
                        where: signedAccount == null
                          ? { RAW: sql`false` }
                          : { blockeeId: signedAccount.actor.id },
                      },
                      blockers: {
                        where: signedAccount == null
                          ? { RAW: sql`false` }
                          : { blockerId: signedAccount.actor.id },
                      },
                    },
                  },
                  link: { with: { creator: true } },
                  mentions: {
                    with: { actor: true },
                  },
                  media: true,
                },
              },
            },
          },
        },
        orderBy: { published: "desc" },
        limit: window + 1,
      });

      return {
        pageInfo: {
          hasNextPage: posts.length > window,
          hasPreviousPage: false,
          startCursor: posts.length < 2
            ? null
            : posts[1].published.toISOString(),
          endCursor: posts.length < 2
            ? null
            : posts.at(-1)!.published.toISOString(),
        },
        edges: posts.slice(0, window).map((
          post,
          i,
        ) => ({
          node: post,
          cursor: posts[i + 1]?.published?.toISOString() ?? "",
          added: post.published,
        })),
      };
    },
  }),
  searchObject: t.field({
    type: SearchedObject,
    nullable: true,
    errors: {
      types: [EmptySearchQueryError],
    },
    args: {
      query: t.arg.string({ required: true }),
    },
    async resolve(_, args, ctx) {
      const query = args.query.trim();
      if (!query) {
        throw new EmptySearchQueryError();
      }

      const result = await searchAsUrl(ctx, query);

      return result == null ? await searchAsHandle(ctx, query) : result;
    },
  }),
}));
