import { isActor } from "@fedify/vocab";
import { persistActor } from "@hackerspub/models/actor";
import type { RelationsFilter } from "@hackerspub/models/db";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import { compileQuery, parseQuery } from "@hackerspub/models/search";
import {
  FULL_HANDLE_REGEXP,
  HANDLE_REGEXP,
} from "@hackerspub/models/searchPatterns";
import { addPostToTimeline, expandLocales } from "@hackerspub/models/timeline";
import { sql } from "drizzle-orm";
import { createGraphQLError } from "graphql-yoga";
import { builder, type UserContext } from "./builder.ts";
import { lookupPostByUrl, parseHttpUrl } from "./lookup.ts";
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
  description:
    "Result of a searchObject lookup: a local redirect URL pointing to the " +
    "matched actor's profile page or post.",
  fields: (t) => ({
    url: t.string(),
  }),
});

async function searchAsUrl(
  ctx: UserContext,
  query: string,
): Promise<{ url: string } | null> {
  const parsed = parseHttpUrl(query);
  if (parsed == null) return null;

  const post = await lookupPostByUrl(ctx, parsed);
  if (post == null) return null;

  await addPostToTimeline(ctx.db, post);

  const actor = await ctx.db.query.actorTable.findFirst({
    where: { id: post.actorId },
  });
  if (actor == null) return null;

  let redirectUrl: string;
  if (actor.accountId == null) {
    redirectUrl = `/${actor.handle}/${post.id}`;
  } else if (post.noteSourceId != null) {
    redirectUrl = `/@${actor.username}/${post.noteSourceId}`;
  } else if (post.articleSourceId != null) {
    redirectUrl = post.url ?? post.iri;
  } else {
    return null;
  }

  return { url: redirectUrl };
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

  // Guests must not trigger federation lookups: they would let unauthenticated
  // callers spawn outbound WebFinger / actor fetches and persist arbitrary
  // remote actors.
  if (ctx.account == null) return null;

  // Try to fetch remote actor using federation context
  const documentLoader = await ctx.fedCtx.getDocumentLoader({
    identifier: ctx.account.id,
  });

  let object;
  try {
    object = await ctx.fedCtx.lookupObject(query, { documentLoader });
  } catch {
    return null;
  }

  if (!isActor(object)) {
    return null;
  }

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
    description: "Full-text post search. Supports keyword operators (see the " +
      "searchGuide query for syntax). Only forward pagination is supported " +
      "(before/last are rejected). Excludes boost wrappers; returns only " +
      "original posts.",
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

      const postFilter: RelationsFilter<"postTable"> = {
        AND: [
          searchFilter,
          signedAccount
            ? getPostVisibilityFilter(signedAccount.actor)
            : { visibility: "public" },
          { sharedPostId: { isNull: true } },
          languages.length < 1
            ? (signedAccount?.hideForeignLanguages &&
                signedAccount.locales != null
              ? { language: { in: expandLocales(signedAccount.locales) } }
              : {})
            : {
              language: {
                in: expandLocales(
                  languages.flatMap((l) =>
                    l.language !== l.baseName
                      ? [l.baseName, l.language]
                      : [l.baseName]
                  ),
                ),
              },
            },
          until == null ? {} : { published: { lte: until } },
        ],
      };

      const postPage = await ctx.db.query.postTable.findMany({
        where: postFilter,
        orderBy: { published: "desc" },
        limit: window + 1,
      });

      const postIds = postPage.map(({ id }) => id);
      const loadedPosts = postIds.length < 1 ? [] : await ctx.db.query.postTable
        .findMany({
          where: { id: { in: postIds } },
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
            quotedPost: {
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
                quotedPost: {
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
        });
      const postsById = new Map(loadedPosts.map((post) => [post.id, post]));
      const posts = postPage.flatMap(({ id }) => {
        const post = postsById.get(id);
        return post == null ? [] : [post];
      });

      return {
        pageInfo: {
          hasNextPage: postPage.length > window,
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
    description:
      "Look up a single actor or post by its fediverse handle (e.g., " +
      "@alice@mastodon.social) or URL. Returns a local redirect URL, or null " +
      "if nothing matches. For authenticated users, triggers federated " +
      "WebFinger/ActivityPub lookups when the object is not already cached.",
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
