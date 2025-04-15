import { type Context, isActor } from "@fedify/fedify";
import type * as vocab from "@fedify/fedify/vocab";
import { sql } from "drizzle-orm";
import type { Disk } from "flydrive";
import { page } from "fresh";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { PostExcerpt } from "../components/PostExcerpt.tsx";
import { PostPagination } from "../components/PostPagination.tsx";
import { db, type RelationsFilter } from "../db.ts";
import { drive } from "../drive.ts";
import { persistActor } from "../models/actor.ts";
import {
  getPostVisibilityFilter,
  isPostObject,
  persistPost,
} from "../models/post.ts";
import type {
  Account,
  Actor,
  Blocking,
  Following,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "../models/schema.ts";
import { compileQuery, parseQuery } from "../models/search.ts";
import { addPostToTimeline } from "../models/timeline.ts";
import { type Uuid, validateUuid } from "../models/uuid.ts";
import { define } from "../utils.ts";

const HANDLE_REGEXP = /@([a-z0-9_]{1,50})$/i;
const FULL_HANDLE_REGEXP = /^@?([^@]+)@([^@]+)$/;

async function searchHandle(
  disk: Disk,
  fedCtx: Context<void>,
  account?: Account,
  keyword?: string | null,
): Promise<string | undefined> {
  keyword = keyword?.trim();
  if (keyword == null || keyword === "") return undefined;
  const match = HANDLE_REGEXP.exec(keyword);
  if (match) {
    const account = await db.query.accountTable.findFirst({
      where: { username: match[1].toLocaleLowerCase() },
    });
    if (account != null) return `/@${account.username}`;
  }
  const fullMatch = FULL_HANDLE_REGEXP.exec(keyword);
  if (!fullMatch) return undefined;
  const origin = `https://${fullMatch[2]}`;
  if (!URL.canParse(origin)) return undefined;
  const host = new URL(origin).host;
  let actor = await db.query.actorTable.findFirst({
    where: {
      username: fullMatch[1],
      OR: [
        { instanceHost: host },
        { handleHost: host },
      ],
    },
  });
  if (actor != null) {
    return actor.accountId == null ? `/${actor.handle}` : `/@${actor.username}`;
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
  actor = await persistActor(db, disk, fedCtx, object, {
    contextLoader: fedCtx.contextLoader,
    documentLoader,
    outbox: false,
  });
  if (actor == null) return undefined;
  return `/${actor.handle}`;
}

async function searchUrl(
  disk: Disk,
  fedCtx: Context<void>,
  account?: Account,
  keyword?: string | null,
): Promise<string | undefined> {
  keyword = keyword?.trim();
  if (keyword == null || !URL.canParse(keyword)) return undefined;
  keyword = new URL(keyword).href;
  let post = await db.query.postTable.findFirst({
    with: { actor: true },
    where: { OR: [{ iri: keyword }, { url: keyword }] },
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
    post = await persistPost(db, disk, fedCtx, object, {
      contextLoader: fedCtx.contextLoader,
      documentLoader,
    });
    if (post == null) return undefined;
    await addPostToTimeline(db, post);
  }
  if (post.actor.accountId == null) {
    return `/${post.actor.handle}/${post.id}`;
  } else if (post.noteSourceId != null) {
    return `/@${post.actor.username}/${post.noteSourceId}`;
  } else if (post.articleSourceId != null) return post.url ?? post.iri;
  return undefined;
}

export const handler = define.handlers(async (ctx) => {
  const query = ctx.url.searchParams.get("query");
  const continuation = ctx.url.searchParams.get("cont");
  const disk = drive.use();
  let redirect = await searchUrl(
    disk,
    ctx.state.fedCtx,
    ctx.state.account,
    query,
  );
  if (redirect != null) return ctx.redirect(redirect);
  redirect = await searchHandle(
    disk,
    ctx.state.fedCtx,
    ctx.state.account,
    query,
  );
  if (redirect != null) return ctx.redirect(redirect);
  const expr = query == null ? undefined : parseQuery(query);
  if (expr != null && expr.type === "hashtag") {
    return ctx.redirect(`/tags/${encodeURIComponent(expr.hashtag)}`);
  }
  const { posts, continuation: next } = expr == null
    ? { posts: [] }
    : await search(
      ctx.state.account,
      compileQuery(expr),
      validateUuid(continuation) ? continuation : null,
    );
  ctx.state.searchQuery = query ?? undefined;
  let nextHref: URL | undefined;
  if (next != null) {
    nextHref = new URL(ctx.url);
    nextHref.searchParams.set("cont", next);
  }
  return page<SearchResultsProps>({ posts, nextHref });
});

export async function search(
  signedAccount: Account & { actor: Actor } | null | undefined,
  filter: RelationsFilter<"postTable">,
  continuation?: Uuid | null,
  window = 50,
): Promise<{ posts: SearchResultsProps["posts"]; continuation?: Uuid }> {
  const posts = await db.query.postTable.findMany({
    where: {
      AND: [
        filter,
        getPostVisibilityFilter(signedAccount?.actor ?? null),
        signedAccount == null ? { visibility: "public" } : {
          OR: [
            { visibility: "public" },
            { actorId: signedAccount.actor.id },
          ],
        },
        { sharedPostId: { isNull: true } },
        continuation == null ? {} : { id: { lte: continuation } },
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
    orderBy: { id: "desc" },
    limit: window + 1,
  });
  return {
    posts: posts.slice(0, window),
    continuation: posts.length > window ? posts[window].id : undefined,
  };
}

export interface SearchResultsProps {
  posts: (Post & {
    actor: Actor & {
      instance: Instance;
      followers: Following[];
      blockees: Blocking[];
      blockers: Blocking[];
    };
    link: PostLink & { creator?: Actor | null } | null;
    sharedPost:
      | Post & {
        actor: Actor & {
          instance: Instance;
          followers: Following[];
          blockees: Blocking[];
          blockers: Blocking[];
        };
        link: PostLink & { creator?: Actor | null } | null;
        replyTarget:
          | Post & {
            actor: Actor & {
              instance: Instance;
              followers: Following[];
              blockees: Blocking[];
              blockers: Blocking[];
            };
            link: PostLink & { creator?: Actor | null } | null;
            mentions: (Mention & { actor: Actor })[];
            media: PostMedium[];
          }
          | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
        shares: Post[];
        reactions: Reaction[];
      }
      | null;
    replyTarget:
      | Post & {
        actor: Actor & {
          instance: Instance;
          followers: Following[];
          blockees: Blocking[];
          blockers: Blocking[];
        };
        link: PostLink & { creator?: Actor | null } | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
      }
      | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
    reactions: Reaction[];
  })[];
  nextHref?: string | URL;
}

export default define.page<typeof handler, SearchResultsProps>(
  function SearchResults({ state: { account }, data: { posts, nextHref } }) {
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
        {nextHref != null && <PostPagination nextHref={nextHref} />}
      </div>
    );
  },
);
