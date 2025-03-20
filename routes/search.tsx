import { type Context, isActor } from "@fedify/fedify";
import type * as vocab from "@fedify/fedify/vocab";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { page } from "fresh";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { PostExcerpt } from "../components/PostExcerpt.tsx";
import { db } from "../db.ts";
import { persistActor } from "../models/actor.ts";
import { isPostObject, persistPost } from "../models/post.ts";
import {
  type Account,
  accountTable,
  type Actor,
  actorTable,
  type Following,
  followingTable,
  type Mention,
  type Post,
  type PostLink,
  type PostMedium,
  postTable,
} from "../models/schema.ts";
import { compileQuery, parseQuery } from "../models/search.ts";
import { define } from "../utils.ts";

const HANDLE_REGEXP = /@([a-z0-9_]{1,50})$/i;
const FULL_HANDLE_REGEXP = /^@?([^@]+)@([^@]+)$/;

async function searchHandle(
  fedCtx: Context<void>,
  account?: Account,
  keyword?: string | null,
): Promise<string | undefined> {
  keyword = keyword?.trim();
  if (keyword == null || keyword === "") return undefined;
  const match = HANDLE_REGEXP.exec(keyword);
  if (match) {
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, match[1].toLocaleLowerCase()),
    });
    if (account != null) return `/@${account.username}`;
  }
  const fullMatch = FULL_HANDLE_REGEXP.exec(keyword);
  if (!fullMatch) return undefined;
  const origin = `https://${fullMatch[2]}`;
  if (!URL.canParse(origin)) return undefined;
  const host = new URL(origin).host;
  let actor = await db.query.actorTable.findFirst({
    where: and(
      eq(actorTable.username, fullMatch[1]),
      eq(actorTable.instanceHost, host),
    ),
  });
  if (actor != null) {
    if (actor.accountId != null) return `/@${actor.username}`;
    return `/@${actor.username}@${actor.instanceHost}`;
  }
  const documentLoader = account == null
    ? fedCtx.documentLoader
    : await fedCtx.getDocumentLoader({ identifier: account.id });
  let object: vocab.Object | null;
  try {
    object = await fedCtx.lookupObject(keyword, { documentLoader });
  } catch {
    return undefined;
  }
  if (!isActor(object)) return undefined;
  actor = await persistActor(db, fedCtx, object, {
    contextLoader: fedCtx.contextLoader,
    documentLoader,
    outbox: false,
  });
  if (actor == null) return undefined;
  return `/@${actor.username}@${actor.instanceHost}`;
}

async function searchUrl(
  fedCtx: Context<void>,
  account?: Account,
  keyword?: string | null,
): Promise<string | undefined> {
  keyword = keyword?.trim();
  if (keyword == null || !URL.canParse(keyword)) return undefined;
  keyword = new URL(keyword).href;
  let post = await db.query.postTable.findFirst({
    with: { actor: true },
    where: or(eq(postTable.iri, keyword), eq(postTable.url, keyword)),
  });
  if (post == null) {
    const documentLoader = account == null
      ? fedCtx.documentLoader
      : await fedCtx.getDocumentLoader({ identifier: account.id });
    let object: vocab.Object | null;
    try {
      object = await fedCtx.lookupObject(keyword, { documentLoader });
    } catch {
      return undefined;
    }
    if (!isPostObject(object)) return undefined;
    post = await persistPost(db, fedCtx, object, {
      contextLoader: fedCtx.contextLoader,
      documentLoader,
    });
    if (post == null) return undefined;
  }
  if (post.actor.accountId == null) {
    return `/@${post.actor.username}@${post.actor.instanceHost}/${post.id}`;
  } else if (post.noteSourceId != null) {
    return `/@${post.actor.username}/${post.noteSourceId}`;
  } else if (post.articleSourceId != null) return post.url ?? post.iri;
  return undefined;
}

export const handler = define.handlers({
  async GET(ctx) {
    const query = ctx.url.searchParams.get("query");
    let redirect = await searchUrl(ctx.state.fedCtx, ctx.state.account, query);
    if (redirect != null) return ctx.redirect(redirect);
    redirect = await searchHandle(
      ctx.state.fedCtx,
      ctx.state.account,
      query,
    );
    if (redirect != null) return ctx.redirect(redirect);
    const expr = query == null ? undefined : parseQuery(query);
    const posts = expr == null ? [] : await db.query.postTable.findMany({
      where: and(compileQuery(db, expr), isNull(postTable.sharedPostId)),
      with: {
        actor: true,
        link: { with: { creator: true } },
        mentions: {
          with: { actor: true },
        },
        media: true,
        shares: {
          where: ctx.state.account == null
            ? sql`false`
            : eq(postTable.actorId, ctx.state.account.actor.id),
        },
        replyTarget: {
          with: {
            actor: {
              with: {
                followers: {
                  where: ctx.state.account == null
                    ? sql`false`
                    : eq(followingTable.followerId, ctx.state.account.actor.id),
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
            actor: true,
            link: { with: { creator: true } },
            mentions: {
              with: { actor: true },
            },
            media: true,
            shares: {
              where: ctx.state.account == null
                ? sql`false`
                : eq(postTable.actorId, ctx.state.account.actor.id),
            },
            replyTarget: {
              with: {
                actor: {
                  with: {
                    followers: {
                      where: ctx.state.account == null ? sql`false` : eq(
                        followingTable.followerId,
                        ctx.state.account.actor.id,
                      ),
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
      orderBy: desc(postTable.published),
    });
    ctx.state.searchQuery = query ?? undefined;
    return page<SearchResultsProps>({
      posts,
    });
  },
});

interface SearchResultsProps {
  posts: (Post & {
    actor: Actor;
    link?: PostLink & { creator?: Actor | null } | null;
    sharedPost:
      | Post & {
        actor: Actor;
        link?: PostLink & { creator?: Actor | null } | null;
        replyTarget:
          | Post & {
            actor: Actor & { followers: Following[] };
            link?: PostLink & { creator?: Actor | null } | null;
            mentions: (Mention & { actor: Actor })[];
            media: PostMedium[];
          }
          | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
        shares: Post[];
      }
      | null;
    replyTarget:
      | Post & {
        actor: Actor & { followers: (Following & { follower?: Actor })[] };
        link?: PostLink & { creator?: Actor | null } | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
      }
      | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
  })[];
}

export default define.page<typeof handler, SearchResultsProps>(
  function SearchResults({ state: { account }, data: { posts } }) {
    return (
      <div>
        <PageTitle>
          <Msg $key="search.title" />
        </PageTitle>
        {posts.length < 1
          ? (
            <div class="text-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="size-8 mx-auto my-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636"
                />
              </svg>
              <Msg $key="search.noResults" />
            </div>
          )
          : (
            <div>
              {posts.map((post) => (
                <PostExcerpt post={post} signedAccount={account} />
              ))}
            </div>
          )}
      </div>
    );
  },
);
