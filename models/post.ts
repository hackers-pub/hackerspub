import { assertAccountActorNotSuspended } from "./moderation.ts";
import {
  type Context,
  type DocumentLoader,
  getUserAgent,
} from "@fedify/fedify";
import {
  isActor,
  LanguageString,
  lookupObject,
  PUBLIC_COLLECTION,
  type Recipient,
  traverseCollection,
} from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { getAnnounce, getNote } from "@hackerspub/federation/objects";
import { sendTagsPubRelayActivity } from "@hackerspub/federation/tags-pub";
import { getLogger } from "@logtape/logtape";
import { assertNever } from "@std/assert/unstable-never";
import {
  and,
  arrayOverlaps,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import iconv from "iconv-lite";
import { Buffer } from "node:buffer";
import ogs from "open-graph-scraper";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { isSSRFSafeURL } from "ssrfcheck";
import {
  getPersistedActor,
  isFederationBlocked,
  persistActor,
  persistActorsByHandles,
  syncActorFromAccount,
  toRecipient,
} from "./actor.ts";
import {
  getArticleSourceMediumUrls,
  getOriginalArticleContent,
} from "./article.ts";
import type { ContextData } from "./context.ts";
import { toDate } from "./date.ts";
import type { Database, RelationsFilter, Transaction } from "./db.ts";
import { extractExternalLinks, stripHtml } from "./html.ts";
import { getMissingArticleMediumLabel, renderMarkup } from "./markup.ts";
import { persistPostMedium } from "./medium.ts";
import { refreshNewsScores, refreshNewsScoresForPostLinks } from "./news.ts";
import {
  createQuotedPostUpdatedNotification,
  createSharedPostUpdatedNotification,
  createShareNotification,
  deleteShareNotification,
} from "./notification.ts";
import { createPoll, type CreatePollInput, persistPoll } from "./poll.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  actorTable,
  type ArticleContent,
  type ArticleSource,
  articleSourceTable,
  type Blocking,
  type Following,
  type Instance,
  type Medium,
  type Mention,
  mentionTable,
  type NewPost,
  type NewPostLink,
  type NoteSource,
  type NoteSourceMedium,
  noteSourceTable,
  type Poll,
  type PollOption,
  type Post,
  type PostLink,
  postLinkTable,
  type PostMedium,
  postMediumTable,
  postTable,
  type PostVisibility,
  quoteAuthorizationTable,
  type QuotePolicy,
  quoteRequestTable,
  type Reaction,
} from "./schema.ts";
import { addPostToTimeline, removeFromTimeline } from "./timeline.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "post"]);
const DEFAULT_MAX_PERSIST_POST_DEPTH = 3;
const DEFAULT_MAX_INLINE_REPLIES = 50;
const DEFAULT_INLINE_REPLIES_THRESHOLD = 10;
const REPLIES_BACKFILL_LOCK_TTL_SECONDS = 300;
const REPLIES_BACKFILL_RETRY_DELAY_MS = 30_000;
// Per-fetch ceiling for remote ActivityPub dereferencing during post
// persistence.  Deno's `fetch` has no default timeout, so an unresponsive
// remote host could otherwise hang an inbox handler past the message queue's
// 60-second handler timeout (and pin a DB connection while it hangs).
// Exported so inbox handlers can apply the same ceiling to pre-persistPost
// fetches (e.g. the initial getObject() type check in onPostShared).
export const REMOTE_FETCH_TIMEOUT_MS = 10_000;
// Wall-clock budget for the synchronous (inline) replies traversal.  Even when
// every individual fetch stays under REMOTE_FETCH_TIMEOUT_MS, a long reply
// collection could otherwise accumulate enough sequential fetches to drag a
// single handler toward the queue timeout, so we stop early and leave the rest
// to the deferred backfill / future federation.
const INLINE_REPLIES_TRAVERSAL_BUDGET_MS = 15_000;
// Overall wall-clock budget for a single synchronous persistPost subtree (one
// inbox message).  The per-fetch (REMOTE_FETCH_TIMEOUT_MS) and inline-replies
// (INLINE_REPLIES_TRAVERSAL_BUDGET_MS) bounds do NOT cap the AGGREGATE of the
// many sequential fetches spread across the reply/quote/reply-target recursion,
// so a handler could still run past PostgresMessageQueue's handlerTimeout.
// That timeout is a Promise.race that does not abort the handler, so the
// handler then keeps running detached and pins a DB connection (Sentry
// GRAPHQL-1H).  This shared deadline is threaded through the synchronous
// recursion so that once it elapses every remaining remote fetch aborts at
// once, the handler unwinds (degrading to partial persistence; large reply sets
// already fall to the deferred backfill), and the connection is released well
// before the 180s queue timeout.
//
// Set to 90s (not 120s) so that operations outside persistPost — the pre-check
// getObject() in onPostShared, DB writes, notification creation, news score
// refresh — have 90s of headroom before the 180s MQ limit.  Exported so
// callers can mint a handler-level AbortSignal that covers both pre-persistPost
// work and the persistPost subtree under one shared deadline.
export const PERSIST_POST_OVERALL_BUDGET_MS = 90_000;
const SCRAPE_IMAGE_METADATA_BYTES_LIMIT = 128 * 1024;
const ARTICLE_LINK_DESCRIPTION_MAX_LENGTH = 500;

function getRemoteFetchSignal(signal?: AbortSignal): AbortSignal {
  const signals = [AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS), signal]
    .filter((s): s is AbortSignal => s != null);
  return AbortSignal.any(signals);
}

/**
 * Wraps a Fedify {@link DocumentLoader} so every remote document fetch is
 * bounded by an {@link AbortSignal.timeout}.  Without this, a single
 * unresponsive remote host can stall an inbox message handler long enough to
 * trip `PostgresMessageQueue`'s handler timeout.  Any caller-supplied signal is
 * preserved by combining it with the timeout via {@link AbortSignal.any}.
 *
 * `overallSignal` is the shared per-subtree deadline
 * ({@link PERSIST_POST_OVERALL_BUDGET_MS}); combining it here is what makes the
 * aggregate of many sequential fetches abortable, not just each fetch on its
 * own.  Exported for unit testing of the signal-combination behavior.
 */
export function withDocumentLoaderTimeout(
  loader: DocumentLoader,
  timeoutMs: number = REMOTE_FETCH_TIMEOUT_MS,
  overallSignal?: AbortSignal,
): DocumentLoader {
  return (url, options) => {
    const signals = [
      options?.signal,
      AbortSignal.timeout(timeoutMs),
      overallSignal,
    ].filter((s): s is AbortSignal => s != null);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    return loader(url, { ...options, signal });
  };
}

export type PostObject = vocab.Article | vocab.Note | vocab.Question;

type NoteSourceMediumWithMedium = NoteSourceMedium & { medium: Medium };
type QuotePolicyPost = Post & {
  actor: Actor & {
    followers: Following[];
    blockees: Blocking[];
    blockers: Blocking[];
  };
  mentions: Mention[];
};

type QuoteUpdatePost = Post & {
  actor: Actor;
  quotedPost: (Post & { actor: Actor }) | null;
  replyTarget: Post | null;
  mentions: (Mention & { actor: Actor })[];
};

type PersistedQuoteTarget = Post & { actor: Actor & { instance: Instance } };

const maxQuoteShareChainDepth = 16;

type PostUpdateComparison = Pick<
  Post,
  "id" | "actorId" | "name" | "contentHtml" | "updated"
>;

function hasNotifiablePostContentChange(
  previousPost: Pick<Post, "name" | "contentHtml"> | undefined,
  updatedPost: Pick<Post, "name" | "contentHtml">,
): boolean {
  return previousPost != null &&
    (previousPost.name !== updatedPost.name ||
      previousPost.contentHtml !== updatedPost.contentHtml);
}

function getActorMentionHrefs(actor: Actor): string[] {
  return [
    actor.iri,
    ...(actor.url == null ? [] : [actor.url]),
    ...actor.aliases,
  ];
}

function deleteActorMentionHrefs(
  mentionHrefs: Set<string>,
  actor: Actor,
): void {
  for (const href of getActorMentionHrefs(actor)) mentionHrefs.delete(href);
}

function isHttpUrl(value: string | undefined | null): value is string {
  if (value == null) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function truncatePlainText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= ARTICLE_LINK_DESCRIPTION_MAX_LENGTH) return text;
  return `${
    text.slice(0, ARTICLE_LINK_DESCRIPTION_MAX_LENGTH - 3).trimEnd()
  }...`;
}

async function persistArticleNewsLink(
  fedCtx: Context<ContextData>,
  article: {
    readonly url: string | null | undefined;
    readonly iri: string;
    readonly name: string | null | undefined;
    readonly summary: string | null | undefined;
    readonly contentHtml: string | null | undefined;
  },
  actor: Pick<Actor, "id" | "name" | "username">,
): Promise<PostLink | undefined> {
  const url = isHttpUrl(article.url) ? article.url : article.iri;
  if (!isHttpUrl(url)) return undefined;
  const parsed = new URL(url);
  const description = article.summary == null || article.summary.trim() === ""
    ? article.contentHtml == null
      ? undefined
      : truncatePlainText(stripHtml(article.contentHtml))
    : truncatePlainText(stripHtml(article.summary));
  const author = actor.name == null || actor.name.trim() === ""
    ? actor.username
    : actor.name;
  const values: NewPostLink = {
    id: generateUuidV7(),
    url: parsed.href,
    title: article.name ?? undefined,
    siteName: parsed.host,
    type: "article",
    description,
    author,
    creatorId: actor.id,
  };
  const rows = await fedCtx.data.db
    .insert(postLinkTable)
    .values(values)
    .onConflictDoUpdate({
      target: postLinkTable.url,
      set: {
        title: values.title,
        siteName: values.siteName,
        type: values.type,
        description: values.description,
        author: values.author,
        creatorId: values.creatorId,
        scraped: sql`CURRENT_TIMESTAMP`,
      },
      setWhere: eq(postLinkTable.url, values.url),
    })
    .returning();
  return rows[0];
}

async function resolveMentionedActors(
  ctx: Context<ContextData>,
  mentionHrefs: ReadonlySet<string>,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  },
): Promise<Actor[]> {
  if (mentionHrefs.size < 1) return [];
  const { db } = ctx.data;
  const unresolvedHrefs = new Set(mentionHrefs);
  const actorsById = new Map<Uuid, Actor>();
  const actorRows = await db.query.actorTable.findMany({
    where: {
      OR: [
        { iri: { in: [...mentionHrefs] } },
        { url: { in: [...mentionHrefs] } },
        { RAW: (table) => arrayOverlaps(table.aliases, [...mentionHrefs]) },
      ],
    },
  });
  for (const actor of actorRows) {
    actorsById.set(actor.id, actor);
    deleteActorMentionHrefs(unresolvedHrefs, actor);
  }
  for (const href of unresolvedHrefs) {
    const apActor = await lookupObject(href, options);
    if (!isActor(apActor)) continue;
    let actor = await persistActor(ctx, apActor, options);
    if (actor == null) continue;
    if (actor.iri !== href && !actor.aliases.includes(href)) {
      const aliases = [...actor.aliases, href];
      await db.update(actorTable)
        .set({ aliases })
        .where(eq(actorTable.id, actor.id));
      actor = { ...actor, aliases };
    }
    actorsById.set(actor.id, actor);
  }
  return [...actorsById.values()];
}

async function createTargetPostUpdatedNotifications(
  db: Database,
  previousPost: Pick<Post, "name" | "contentHtml"> | undefined,
  updatedPost: PostUpdateComparison,
  updatingActor: Actor,
): Promise<void> {
  if (!hasNotifiablePostContentChange(previousPost, updatedPost)) return;
  const originalAuthorAccountId = updatingActor.accountId;
  const shouldNotifyAccount = (
    accountId: Uuid | null,
  ): accountId is Uuid =>
    accountId != null && accountId !== originalAuthorAccountId;

  const shareRows = await db
    .select({ accountId: actorTable.accountId })
    .from(postTable)
    .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
    .where(and(
      eq(postTable.sharedPostId, updatedPost.id),
      isNotNull(actorTable.accountId),
    ));
  const sharingAccountIds = new Set(
    shareRows.map((row) => row.accountId).filter(shouldNotifyAccount),
  );
  for (const accountId of sharingAccountIds) {
    await createSharedPostUpdatedNotification(
      db,
      accountId,
      updatedPost,
      updatingActor,
    );
  }

  const directQuoteRows = await db
    .select({ accountId: actorTable.accountId })
    .from(postTable)
    .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
    .where(and(
      eq(postTable.quotedPostId, updatedPost.id),
      isNotNull(actorTable.accountId),
    ));
  const quoteRequestRows = await db
    .select({ accountId: actorTable.accountId })
    .from(quoteRequestTable)
    .innerJoin(postTable, eq(postTable.id, quoteRequestTable.quotePostId))
    .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
    .where(and(
      eq(quoteRequestTable.quotedPostId, updatedPost.id),
      isNull(quoteRequestTable.accepted),
      isNull(quoteRequestTable.rejected),
      isNotNull(actorTable.accountId),
    ));
  const quotingAccountIds = new Set(
    [...directQuoteRows, ...quoteRequestRows]
      .map((row) => row.accountId)
      .filter(shouldNotifyAccount),
  );
  for (const accountId of quotingAccountIds) {
    await createQuotedPostUpdatedNotification(
      db,
      accountId,
      updatedPost,
      updatingActor,
    );
  }
}

export function isPostObject(object: unknown): object is PostObject {
  return object instanceof vocab.Article || object instanceof vocab.Note ||
    object instanceof vocab.Question;
}

export function isArticleLike(
  post: Post & { actor: Actor & { instance: Instance } },
): boolean {
  if (post.type === "Question") return false;
  return post.type === "Article" ||
    post.name != null && post.actor.instance.software !== "nodebb";
}

export function normalizeQuotePolicyForVisibility(
  visibility: PostVisibility,
  quotePolicy: QuotePolicy | null | undefined,
): QuotePolicy {
  if (visibility !== "public" && visibility !== "unlisted") return "self";
  return quotePolicy ?? "everyone";
}

function quotePolicyFromApprovalUrls(
  post: PostObject,
  approvalUrls: string[],
  authorFollowersUrl: string | null,
): QuotePolicy | undefined {
  if (approvalUrls.includes(PUBLIC_COLLECTION.href)) return "everyone";
  if (authorFollowersUrl != null && approvalUrls.includes(authorFollowersUrl)) {
    return "followers";
  }
  if (
    post.attributionId != null &&
    approvalUrls.includes(post.attributionId.href)
  ) {
    return "self";
  }
  return undefined;
}

function quotePoliciesFromInteractionPolicy(
  post: PostObject,
  visibility: PostVisibility,
  authorFollowersUrl: string | null,
): {
  quotePolicy: QuotePolicy;
  quoteRequestPolicy: QuotePolicy | null;
} {
  if (visibility !== "public" && visibility !== "unlisted") {
    return { quotePolicy: "self", quoteRequestPolicy: null };
  }
  const policy = post.interactionPolicy?.canQuote;
  if (policy == null) {
    return {
      quotePolicy: normalizeQuotePolicyForVisibility(visibility, undefined),
      quoteRequestPolicy: null,
    };
  }
  const quotePolicy = quotePolicyFromApprovalUrls(
    post,
    policy.automaticApprovals.map((url) => url.href),
    authorFollowersUrl,
  ) ?? "self";
  const quoteRequestPolicy = quotePolicyFromApprovalUrls(
    post,
    policy.manualApprovals.map((url) => url.href),
    authorFollowersUrl,
  ) ?? null;
  return { quotePolicy, quoteRequestPolicy };
}

function canActorQuoteByPolicy(
  post: Post & { actor: Actor & { followers: Following[] } },
  actor: Actor,
  policy: QuotePolicy,
): boolean {
  if (post.actorId === actor.id) return true;
  if (policy === "everyone") return true;
  if (policy === "followers") {
    return post.actor.followers.some((follower) =>
      follower.followerId === actor.id && follower.accepted != null
    );
  }
  return false;
}

export function canActorQuotePost(
  post: Post & {
    actor: Actor & {
      followers: Following[];
      blockees: Blocking[];
      blockers: Blocking[];
    };
    mentions: Mention[];
  },
  actor: Actor,
): boolean {
  if (post.sharedPostId != null) return false;
  if (post.visibility === "direct" || post.visibility === "none") return false;
  if (!isPostVisibleTo(post, actor)) return false;
  return canActorQuoteByPolicy(post, actor, post.quotePolicy);
}

export function canActorRequestQuotePost(
  post: Post & {
    actor: Actor & {
      followers: Following[];
      blockees: Blocking[];
      blockers: Blocking[];
    };
    mentions: Mention[];
  },
  actor: Actor,
): boolean {
  if (canActorQuotePost(post, actor)) return true;
  if (post.sharedPostId != null) return false;
  if (post.visibility === "direct" || post.visibility === "none") return false;
  if (!isPostVisibleTo(post, actor)) return false;
  if (post.quoteRequestPolicy == null) return false;
  return canActorQuoteByPolicy(post, actor, post.quoteRequestPolicy);
}

export async function getAllowedQuoteTargetForActor(
  db: Database,
  actor: Actor,
  post: Post,
): Promise<QuotePolicyPost | undefined> {
  const targetPostId = await getOriginalPostId(db, post);
  if (targetPostId == null) return undefined;
  const quotedPost: QuotePolicyPost | undefined = await db.query.postTable
    .findFirst({
      with: {
        actor: {
          with: {
            followers: { where: { followerId: actor.id } },
            blockees: { where: { blockeeId: actor.id } },
            blockers: { where: { blockerId: actor.id } },
          },
        },
        mentions: { where: { actorId: actor.id } },
      },
      where: { id: targetPostId },
    });
  if (quotedPost == null) return undefined;
  // A censored post cannot be quoted (by anyone, including its author):
  // quoting re-amplifies moderation-hidden content.  The submitted row
  // is checked too, so a censored share wrapper cannot be used as a
  // quote handle either.
  if (post.censored != null || quotedPost.censored != null) {
    return undefined;
  }
  const allowed = canActorRequestQuotePost(quotedPost, actor);
  return allowed ? quotedPost : undefined;
}

export async function getOriginalPostId(
  db: Database,
  post: Pick<Post, "id" | "sharedPostId">,
): Promise<Uuid | undefined> {
  const visited = new Set<Uuid>([post.id]);
  let target = post;
  let depth = 0;
  while (target.sharedPostId != null) {
    if (depth >= maxQuoteShareChainDepth) return undefined;
    depth++;
    if (visited.has(target.sharedPostId)) return undefined;
    visited.add(target.sharedPostId);
    const next = await db.query.postTable.findFirst({
      columns: { id: true, sharedPostId: true },
      where: { id: target.sharedPostId },
    });
    if (next == null) return undefined;
    target = next;
  }
  return target.id;
}

async function readResponseBytesAtMost(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.body == null) {
    return new Uint8Array((await response.arrayBuffer()).slice(0, maxBytes));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // Stop reading once we have enough bytes for lightweight metadata probing.
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || value == null) break;
      if (total + value.length <= maxBytes) {
        chunks.push(value);
        total += value.length;
        continue;
      }
      const remaining = maxBytes - total;
      if (remaining > 0) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
      }
      break;
    }
  } finally {
    // Cancel the unread remainder so Deno closes the underlying HTTP body
    // resource here, with the cancellation awaited (and any rejection
    // swallowed).  Without this, a partially-read body is abandoned with its
    // reader still locked; when the peer tears the keep-alive connection down
    // mid-flight, the dangling read rejects with "resource closed" as a
    // *detached* unhandled rejection that escapes the caller's try/catch and
    // is only caught by the instrument.ts backstop (GRAPHQL-1N).
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function syncPostFromArticleSource(
  fedCtx: Context<ContextData>,
  articleSource: ArticleSource & {
    account: Account & {
      avatarMedium: Medium | null;
      emails: AccountEmail[];
      links: AccountLink[];
    };
    contents: ArticleContent[];
  },
): Promise<
  Post & {
    actor: Actor & {
      account: Account & {
        avatarMedium: Medium | null;
        emails: AccountEmail[];
        links: AccountLink[];
      };
      instance: Instance;
    };
    articleSource: ArticleSource & {
      account: Account & {
        avatarMedium: Medium | null;
        emails: AccountEmail[];
        links: AccountLink[];
      };
      contents: ArticleContent[];
    };
    mentions: Mention[];
  }
> {
  const { db, kv, disk } = fedCtx.data;
  const actor = await syncActorFromAccount(fedCtx, articleSource.account);
  const content = getOriginalArticleContent(articleSource);
  if (content == null) {
    throw new Error("No content.");
  }
  const rendered = await renderMarkup(fedCtx, content.content, {
    docId: articleSource.id,
    kv,
    mediumUrls: await getArticleSourceMediumUrls(db, disk, articleSource.id),
    missingMediumLabel: getMissingArticleMediumLabel(content.language),
  });
  const url =
    `${fedCtx.origin}/@${articleSource.account.username}/${articleSource.publishedYear}/${
      encodeURIComponent(articleSource.slug)
    }`;
  const link = await persistArticleNewsLink(fedCtx, {
    url,
    iri: fedCtx.getObjectUri(vocab.Article, { id: articleSource.id }).href,
    name: content.title,
    summary: content.summary,
    contentHtml: rendered.html,
  }, actor);
  const values: Omit<NewPost, "id"> = {
    iri: fedCtx.getObjectUri(vocab.Article, { id: articleSource.id }).href,
    type: "Article",
    visibility: "public",
    quotePolicy: articleSource.quotePolicy,
    actorId: actor.id,
    articleSourceId: articleSource.id,
    name: content.title,
    summary: content.summary,
    contentHtml: rendered.html,
    language: content.language,
    tags: Object.fromEntries(
      [...articleSource.tags, ...rendered.hashtags].map((tag) => [
        tag.toLowerCase().replace(/^#/, ""),
        `${fedCtx.canonicalOrigin}/tags/${
          encodeURIComponent(tag.replace(/^#/, ""))
        }`,
      ]),
    ),
    linkId: link?.id ?? null,
    linkUrl: link?.url ?? null,
    url,
    updated: articleSource.updated,
    published: articleSource.published,
  };
  const existingPost = await db.query.postTable.findFirst({
    columns: { id: true, name: true, contentHtml: true, linkId: true },
    where: { articleSourceId: articleSource.id },
  });
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.articleSourceId,
      set: values,
      setWhere: eq(postTable.articleSourceId, articleSource.id),
    })
    .returning();
  const [post] = rows;
  await createTargetPostUpdatedNotifications(db, existingPost, post, actor);
  await db.delete(mentionTable).where(eq(mentionTable.postId, post.id));
  const mentionList = globalThis.Object.values(rendered.mentions);
  const mentions = mentionList.length > 0
    ? await db.insert(mentionTable).values(
      mentionList.map((actor) => ({
        postId: post.id,
        actorId: actor.id,
      })),
    ).onConflictDoNothing().returning()
    : [];
  await refreshNewsScores(db, [post.linkId, existingPost?.linkId]);
  return { ...post, actor, mentions, articleSource };
}

export async function syncPostFromNoteSource(
  fedCtx: Context<ContextData>,
  noteSource: NoteSource & {
    account: Account & {
      avatarMedium: Medium | null;
      emails: AccountEmail[];
      links: AccountLink[];
    };
    media: NoteSourceMediumWithMedium[];
  },
  relations: {
    replyTarget?: Post & { actor: Actor };
    quotedPost?: Post & { actor: Actor };
    question?: {
      title: string;
      poll: CreatePollInput;
    };
  } = {},
): Promise<
  | Post & {
    actor: Actor & {
      account: Account & {
        avatarMedium: Medium | null;
        emails: AccountEmail[];
        links: AccountLink[];
      };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & {
        avatarMedium: Medium | null;
        emails: AccountEmail[];
        links: AccountLink[];
      };
      media: NoteSourceMediumWithMedium[];
    };
    replyTarget: Post & { actor: Actor } | null;
    quotedPost: Post & { actor: Actor } | null;
    quoteRequestRequired: boolean;
    quoteRequestTarget: Post & { actor: Actor } | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    poll: (Poll & { options: PollOption[] }) | null;
  }
  | undefined
> {
  const { db, kv, disk } = fedCtx.data;
  const existingPost = await db.query.postTable.findFirst({
    columns: {
      id: true,
      type: true,
      name: true,
      contentHtml: true,
      quotedPostId: true,
      quoteAuthorizationIri: true,
      quoteTargetState: true,
      linkId: true,
    },
    where: { noteSourceId: noteSource.id },
  });
  const type = existingPost?.type ??
    (relations.question == null ? "Note" : "Question");
  if (existingPost != null && existingPost.type !== type) return undefined;
  const iri = type === "Question"
    ? fedCtx.getObjectUri(vocab.Question, { id: noteSource.id }).href
    : fedCtx.getObjectUri(vocab.Note, { id: noteSource.id }).href;
  const actor = await syncActorFromAccount(fedCtx, noteSource.account);
  const hasQuotedPostRelation = Object.hasOwn(relations, "quotedPost");
  let quotedPost: QuotePolicyPost | undefined;
  if (relations.quotedPost != null) {
    quotedPost = await getAllowedQuoteTargetForActor(
      db,
      actor,
      relations.quotedPost,
    );
    if (quotedPost == null) {
      logger.warn("Rejecting local quote creation due to quote policy.", {
        noteSourceId: noteSource.id,
        actorId: actor.id,
        quotedPostId: relations.quotedPost.sharedPostId ??
          relations.quotedPost.id,
      });
      return undefined;
    }
  }
  // FIXME: Note should be rendered in a different way
  const rendered = await renderMarkup(fedCtx, noteSource.content, {
    docId: noteSource.id,
    kv,
  });
  const externalLinks = extractExternalLinks(rendered.html);
  const link = externalLinks.length > 0
    ? await persistPostLink(fedCtx, externalLinks[0])
    : undefined;
  const url = new URL(
    `/@${noteSource.account.username}/${noteSource.id}`,
    fedCtx.canonicalOrigin,
  ).href;
  const id = existingPost?.id ?? generateUuidV7();
  const quoteTargetId = quotedPost?.id ?? null;
  const existingQuoteAuthorizationIri =
    existingPost != null && existingPost.quotedPostId === quoteTargetId
      ? existingPost.quoteAuthorizationIri
      : null;
  const quoteRequestRequired = quotedPost != null &&
    !canActorQuotePost(quotedPost, actor) &&
    existingQuoteAuthorizationIri == null;
  const quotedPostId = !hasQuotedPostRelation && existingPost != null
    ? undefined
    : quoteRequestRequired
    ? null
    : quoteTargetId;
  const quoteAuthorizationIri = !hasQuotedPostRelation && existingPost != null
    ? undefined
    : quotedPost == null
    ? null
    : quoteRequestRequired
    ? null
    : quotedPost.actor.accountId == null
    ? existingQuoteAuthorizationIri
    : quotedPost.actorId === actor.id
    ? null
    : fedCtx.getObjectUri(vocab.QuoteAuthorization, { id }).href;
  const quoteTargetState = !hasQuotedPostRelation && existingPost != null
    ? undefined
    : quoteRequestRequired
    ? "pending"
    : null;
  const values: Omit<NewPost, "id"> = {
    iri,
    type,
    visibility: noteSource.visibility,
    quotePolicy: normalizeQuotePolicyForVisibility(
      noteSource.visibility,
      noteSource.quotePolicy,
    ),
    actorId: actor.id,
    noteSourceId: noteSource.id,
    replyTargetId: relations.replyTarget?.id,
    quotedPostId,
    quoteAuthorizationIri,
    quoteTargetState,
    name: relations.question?.title,
    contentHtml: rendered.html,
    language: noteSource.language,
    tags: Object.fromEntries(
      rendered.hashtags.map((tag) => [
        tag.toLowerCase().replace(/^#/, ""),
        `${fedCtx.canonicalOrigin}/tags/${
          encodeURIComponent(tag.replace(/^#/, ""))
        }`,
      ]),
    ),
    // Use explicit `null` (not `undefined`) so editing a note to remove its
    // link actually clears `link_id` on update: drizzle drops `undefined` from
    // the update set, which would otherwise leave the old link attached (and
    // keep a dropped story in the news feed).  Matches `persistPost`.
    linkId: link?.id ?? null,
    linkUrl: link == null
      ? null
      : externalLinks[0].hash === ""
      ? link.url
      : new URL(externalLinks[0].hash, link.url).href,
    url,
    updated: noteSource.updated,
    published: noteSource.published,
  };
  const rows = await db.insert(postTable)
    .values({ id, ...values })
    .onConflictDoUpdate({
      target: postTable.noteSourceId,
      set: values,
      setWhere: eq(postTable.noteSourceId, noteSource.id),
    })
    .returning();
  const post = rows[0];
  await createTargetPostUpdatedNotifications(db, existingPost, post, actor);
  if (post.quoteAuthorizationIri != null && quotedPost != null) {
    await db.insert(quoteAuthorizationTable).values({
      id,
      iri: post.quoteAuthorizationIri,
      quotePostIri: post.iri,
      quotePostId: post.id,
      quotedPostId: quotedPost.sharedPostId ?? quotedPost.id,
      attributedActorId: quotedPost.actorId,
    }).onConflictDoUpdate({
      target: quoteAuthorizationTable.iri,
      set: {
        quotePostIri: post.iri,
        quotePostId: post.id,
        quotedPostId: quotedPost.sharedPostId ?? quotedPost.id,
        attributedActorId: quotedPost.actorId,
        revoked: false,
        updated: sql`CURRENT_TIMESTAMP`,
      },
    });
  }
  await db.delete(mentionTable).where(eq(mentionTable.postId, post.id));
  const mentionList = globalThis.Object.values(rendered.mentions);

  if (hasQuotedPostRelation && quoteAuthorizationIri == null) {
    await db.delete(quoteAuthorizationTable)
      .where(eq(quoteAuthorizationTable.quotePostId, post.id));
  }
  if (
    hasQuotedPostRelation &&
    existingPost?.quotedPostId != null &&
    existingPost.quotedPostId !== quotedPostId
  ) {
    const previousQuotedPost = await db.query.postTable.findFirst({
      where: { id: existingPost.quotedPostId },
    });
    if (previousQuotedPost != null) {
      await updateQuotesCount(db, previousQuotedPost, -1);
    }
  }
  if (
    hasQuotedPostRelation && quotedPost != null &&
    quotedPostId != null &&
    existingPost?.quotedPostId !== quotedPostId
  ) {
    await updateQuotesCount(db, quotedPost, 1);
  }
  const mentions = mentionList.length > 0
    ? (await db.insert(mentionTable).values(
      mentionList.map((actor) => ({
        postId: post.id,
        actorId: actor.id,
      })),
    ).onConflictDoNothing().returning()).map((m) => ({
      ...m,
      actor: mentionList.find((a) => a.id === m.actorId)!,
    }))
    : [];
  await db.delete(postMediumTable).where(eq(postMediumTable.postId, post.id));
  const media = noteSource.media.length > 0
    ? await db.insert(postMediumTable).values(
      await Promise.all(noteSource.media.map(async (medium) => ({
        postId: post.id,
        index: medium.index,
        type: medium.medium.type,
        url: await disk.getUrl(medium.medium.key),
        alt: medium.alt,
        width: medium.medium.width,
        height: medium.medium.height,
      }))),
    ).returning()
    : [];
  const poll = relations.question == null
    ? null
    : await createPoll(db, post.id, relations.question.poll);
  const returnedQuotedPost = hasQuotedPostRelation
    ? quoteRequestRequired ? null : quotedPost ?? null
    : post.quotedPostId == null
    ? null
    : await db.query.postTable.findFirst({
      where: { id: post.quotedPostId },
      with: { actor: true },
    }) ?? null;
  const quoteRequestTarget = quoteRequestRequired ? quotedPost ?? null : null;
  // Score the link this note now shares; also refresh the previous link when
  // an edit changed or removed it, so the old story can drop out.
  await refreshNewsScores(db, [post.linkId, existingPost?.linkId]);
  return {
    ...post,
    actor,
    noteSource,
    mentions,
    media,
    replyTarget: relations.replyTarget ?? null,
    quotedPost: returnedQuotedPost,
    quoteRequestRequired,
    quoteRequestTarget,
    poll,
  };
}

export async function persistPost(
  ctx: Context<ContextData>,
  post: PostObject,
  options: {
    actor?: Actor & { instance: Instance };
    replyTarget?: Post & { actor: Actor & { instance: Instance } };
    replies?: boolean;
    depth?: number;
    maxDepth?: number;
    maxReplies?: number;
    inlineRepliesThreshold?: number;
    deferLargeReplies?: boolean;
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
    /**
     * Shared overall deadline for the whole synchronous persist subtree.  Left
     * unset by top-level callers (an inbox handler): the first call mints one
     * from {@link PERSIST_POST_OVERALL_BUDGET_MS} and threads it through the
     * synchronous recursion so every level shares one budget.  The deferred
     * reply backfill deliberately does NOT inherit it (each backfilled reply
     * gets its own fresh budget instead of being cut off by the handler's).
     */
    signal?: AbortSignal;
  } = {},
): Promise<
  | Post & {
    actor: Actor & { instance: Instance };
    mentions: (Mention & { actor: Actor })[];
    replyTarget: Post & { actor: Actor } | null;
    quotedPost: Post & { actor: Actor } | null;
    poll: Poll | null;
  }
  | undefined
> {
  if (post.id == null || post.attributionId == null || post.content == null) {
    logger.debug(
      "Missing required fields (id, attributedTo, content): {post}",
      { post },
    );
    return;
  }
  const { db } = ctx.data;
  const depth = options.depth ?? 0;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_PERSIST_POST_DEPTH;
  const maxReplies = options.maxReplies ?? DEFAULT_MAX_INLINE_REPLIES;
  const inlineRepliesThreshold = options.inlineRepliesThreshold ??
    DEFAULT_INLINE_REPLIES_THRESHOLD;
  const deferLargeReplies = options.deferLargeReplies ?? true;
  const shouldRecurse = depth < maxDepth;
  if (post.id.origin === ctx.canonicalOrigin) {
    return await getPersistedPost(db, post.id);
  }
  let actor =
    options.actor == null || options.actor.iri !== post.attributionId.href
      ? await getPersistedActor(db, post.attributionId)
      : options.actor;
  // One deadline for the entire synchronous subtree: reuse the parent's when
  // recursing, otherwise mint a fresh one at the top-level (handler) call.
  const overallSignal = options.signal ??
    AbortSignal.timeout(PERSIST_POST_OVERALL_BUDGET_MS);
  const opts = {
    contextLoader: options.contextLoader,
    documentLoader: withDocumentLoaderTimeout(
      options.documentLoader ?? ctx.documentLoader,
      REMOTE_FETCH_TIMEOUT_MS,
      overallSignal,
    ),
    suppressError: true,
  };
  if (actor != null && isFederationBlocked(actor)) return undefined;
  if (actor == null) {
    const apActor = await post.getAttribution(opts);
    if (apActor == null) return;
    // Use `opts`, not `options`: `opts.documentLoader` is bounded by the
    // per-fetch timeout and the shared `overallSignal`, so persistActor's own
    // dereferencing (icon/image/attachments/featured/tags) cannot stall this
    // handler past the queue timeout.
    actor = await persistActor(ctx, apActor, opts);
    if (actor == null) {
      logger.debug("Failed to persist actor: {actor}", { actor: apActor });
      return;
    }
  }
  const tags: Record<string, string> = {};
  const mentions = new Set<string>();
  const emojis: Record<string, string> = {};
  const quotedPostIris: string[] = [];
  for await (const tag of post.getTags(opts)) {
    if (tag instanceof vocab.Hashtag) {
      if (tag.name == null || tag.href == null) continue;
      tags[tag.name.toString().replace(/^#/, "").toLowerCase()] = tag.href.href;
    } else if (tag instanceof vocab.Mention) {
      if (tag.href == null) continue;
      mentions.add(tag.href.href);
    } else if (tag instanceof vocab.Emoji) {
      if (tag.name == null) continue;
      const icon = await tag.getIcon(opts);
      if (
        icon?.url == null ||
        icon.url instanceof vocab.Link && icon.url.href == null
      ) {
        continue;
      }
      emojis[tag.name.toString()] = icon.url instanceof URL
        ? icon.url.href
        : icon.url.href!.href;
    } else if (tag instanceof vocab.Link) {
      if (tag.mediaType == null || tag.href == null) continue;
      const [mediaType, ...paramList] = tag.mediaType.split(/\s*;\s*/g);
      const params = Object.fromEntries(
        paramList.map((param) => {
          let [key, value] = param.split(/\s*=\s*/g);
          // value can be quoted:
          value = value.match(/^"([^"]*)"\s*$/)?.[1] ?? value.trim();
          return [key.trim(), value];
        }),
      );
      if (
        mediaType !== "application/activity+json" &&
        !(mediaType === "application/ld+json" &&
          params.profile === "https://www.w3.org/ns/activitystreams")
      ) {
        continue;
      }
      if (quotedPostIris.includes(tag.href.href)) continue;
      quotedPostIris.push(tag.href.href);
    }
  }
  if (post.quoteUrl != null) {
    if (!quotedPostIris.includes(post.quoteUrl.href)) {
      quotedPostIris.push(post.quoteUrl.href);
    }
  }
  if (post.quoteId != null) {
    if (!quotedPostIris.includes(post.quoteId.href)) {
      quotedPostIris.unshift(post.quoteId.href);
    }
  }
  let quotedPost: PersistedQuoteTarget | undefined;
  let quotedPostIri: string | undefined;
  if (quotedPostIris.length > 0) {
    const quotedPosts = await db.query.postTable.findMany({
      with: {
        actor: {
          with: { instance: true },
        },
      },
      where: { iri: { in: quotedPostIris } },
    });
    quotedPosts.sort((a, b) =>
      quotedPostIris.indexOf(a.iri) - quotedPostIris.indexOf(b.iri)
    );
    if (quotedPosts.length > 0) {
      quotedPost = quotedPosts[0];
      quotedPostIri = quotedPost.iri;
    } else if (shouldRecurse) {
      for (const iri of quotedPostIris) {
        let obj: vocab.Object | null;
        try {
          obj = await ctx.lookupObject(iri, opts);
        } catch {
          continue;
        }
        if (!isPostObject(obj)) continue;
        quotedPost = await persistPost(ctx, obj, {
          replies: false,
          depth: depth + 1,
          maxDepth,
          maxReplies,
          inlineRepliesThreshold,
          deferLargeReplies: false,
          contextLoader: options.contextLoader,
          documentLoader: options.documentLoader,
          signal: overallSignal,
        });
        if (quotedPost != null) {
          quotedPostIri = iri;
          break;
        }
      }
    }
  }
  if (quotedPost != null) {
    quotedPost = await getOriginalQuoteTarget(db, quotedPost);
  }
  const attachments: vocab.Document[] = [];
  for await (const attachment of post.getAttachments(opts)) {
    if (attachment instanceof vocab.Document) attachments.push(attachment);
  }
  let replyTarget: Post & { actor: Actor & { instance: Instance } } | undefined;
  if (post.replyTargetId != null) {
    replyTarget = options.replyTarget ??
      await getPersistedPost(db, post.replyTargetId);
    if (replyTarget == null && shouldRecurse) {
      const apReplyTarget = await post.getReplyTarget(opts);
      if (!isPostObject(apReplyTarget)) return;
      replyTarget = await persistPost(ctx, apReplyTarget, {
        ...options,
        replies: false,
        depth: depth + 1,
        signal: overallSignal,
      });
      if (replyTarget == null) return;
    }
  }
  const replies = options.replies ? await post.getReplies(opts) : null;
  const shares = await post.getShares(opts);
  const to = new Set(post.toIds.map((u) => u.href));
  const cc = new Set(post.ccIds.map((u) => u.href));
  const recipients = to.union(cc);
  const visibility: PostVisibility = to.has(PUBLIC_COLLECTION.href)
    ? "public"
    : cc.has(PUBLIC_COLLECTION.href)
    ? "unlisted"
    : actor.followersUrl != null && recipients.has(actor.followersUrl) &&
        mentions.isSubsetOf(recipients)
    ? "followers"
    : mentions.isSubsetOf(recipients)
    ? "direct"
    : "none";
  logger.debug(
    "Post visibility: {visibility} (drived from recipients {recipients} and " +
      "mentions {mentions}).",
    { visibility, recipients, to, cc, mentions },
  );
  const { quotePolicy, quoteRequestPolicy } =
    quotePoliciesFromInteractionPolicy(
      post,
      visibility,
      actor.followersUrl,
    );
  let quoteAuthorizationIri = post.quoteAuthorizationId?.href;
  const existingPost = await db.query.postTable.findFirst({
    columns: {
      id: true,
      name: true,
      contentHtml: true,
      quotedPostId: true,
      linkId: true,
    },
    where: { iri: post.id.href },
  });
  if (quoteAuthorizationIri != null && quotedPost != null) {
    const authorization = await post.getQuoteAuthorization(opts);
    let validAuthorization =
      authorization instanceof vocab.QuoteAuthorization &&
      authorization.interactingObjectId?.href === post.id.href &&
      authorization.interactionTargetId?.href === quotedPost.iri &&
      authorization.attributionId?.href === quotedPost.actor.iri;
    if (validAuthorization && quotedPost.actor.accountId != null) {
      const issuedAuthorization = await db.select({
        id: quoteAuthorizationTable.id,
      })
        .from(quoteAuthorizationTable)
        .where(and(
          eq(quoteAuthorizationTable.iri, quoteAuthorizationIri),
          eq(quoteAuthorizationTable.quotePostIri, post.id.href),
          eq(quoteAuthorizationTable.quotedPostId, quotedPost.id),
          eq(quoteAuthorizationTable.attributedActorId, quotedPost.actorId),
          eq(quoteAuthorizationTable.revoked, false),
        ))
        .limit(1);
      validAuthorization = issuedAuthorization.length > 0;
    } else if (validAuthorization) {
      // Fedify dereferences cross-origin embedded authorizations before this.
      validAuthorization = new URL(quoteAuthorizationIri).origin ===
        new URL(quotedPost.actor.iri).origin;
    }
    if (!validAuthorization) {
      logger.debug("Ignoring invalid quote authorization: {iri}", {
        iri: quoteAuthorizationIri,
      });
      quoteAuthorizationIri = undefined;
    }
  }
  if (
    quotedPost?.visibility === "direct" || quotedPost?.visibility === "none"
  ) {
    logger.debug("Ignoring quoted post with private visibility: {iri}", {
      iri: quotedPost.iri,
    });
    quotedPost = undefined;
  }
  let unauthorizedQuoteTarget: PersistedQuoteTarget | undefined;
  // A censored post cannot be quoted, even through a quote authorization
  // issued before moderators censored it.  This runs before (and independent
  // of) the policy check below, which the authorization path skips, so
  // censorship is never overridden by an outstanding authorization.
  if (quotedPost != null && quotedPost.censored != null) {
    logger.debug("Ignoring censored quoted post: {iri}", {
      iri: quotedPost.iri,
    });
    unauthorizedQuoteTarget = quotedPost;
    quotedPost = undefined;
    quoteAuthorizationIri = undefined;
  }
  if (
    quotedPost != null &&
    quoteAuthorizationIri == null &&
    !(await canPersistIncomingQuote(db, quotedPost.id, actor))
  ) {
    logger.debug("Ignoring quoted post denied by quote policy: {iri}", {
      iri: quotedPost.iri,
    });
    unauthorizedQuoteTarget = quotedPost;
    quotedPost = undefined;
  }
  if (quotedPost == null && quoteAuthorizationIri != null) {
    logger.debug("Ignoring quote authorization without quote target: {iri}", {
      iri: quoteAuthorizationIri,
    });
    quoteAuthorizationIri = undefined;
  }
  const quoteTargetState: Post["quoteTargetState"] = quotedPost != null ||
      quotedPostIris.length < 1 || existingPost == null ||
      unauthorizedQuoteTarget == null
    ? null
    : await getPersistedQuoteTargetState(
      db,
      existingPost.id,
      unauthorizedQuoteTarget.id,
    );
  const mentionedActors = await resolveMentionedActors(ctx, mentions, opts);
  const mentionLinkHrefs = new Set(mentions);
  for (const actor of mentionedActors) {
    for (const href of getActorMentionHrefs(actor)) mentionLinkHrefs.add(href);
  }
  const contentHtml = post.content?.toString();
  const postUrl = post.url instanceof vocab.Link
    ? post.url.href?.href
    : post.url?.href;
  const type = post instanceof vocab.Article
    ? "Article"
    : post instanceof vocab.Note
    ? "Note"
    : post instanceof vocab.Question
    ? "Question"
    : assertNever(post, `Unexpected type of post: ${post}`);
  const isQualifyingArticleNewsPost = type === "Article" &&
    (visibility === "public" || visibility === "unlisted") &&
    replyTarget == null &&
    quotedPost == null;
  const articleNewsLink = isQualifyingArticleNewsPost
    ? await persistArticleNewsLink(ctx, {
      url: postUrl,
      iri: post.id.href,
      name: post.name?.toString(),
      summary: post.summary?.toString(),
      contentHtml,
    }, actor)
    : undefined;
  let externalLinks = contentHtml == null
    ? []
    : extractExternalLinks(contentHtml, { excludeHrefs: mentionLinkHrefs });
  if (quotedPost != null) {
    externalLinks = externalLinks.filter((l) =>
      quotedPost.iri !== l.href &&
      quotedPost.url !== l.href &&
      quotedPostIri !== l.href
    );
  }
  const embeddedLink = articleNewsLink == null && externalLinks.length > 0
    ? await persistPostLink(ctx, externalLinks[0], { signal: overallSignal })
    : undefined;
  const link = articleNewsLink ?? embeddedLink;
  const values: Omit<NewPost, "id"> = {
    iri: post.id.href,
    type,
    visibility,
    quotePolicy,
    quoteRequestPolicy,
    actorId: actor.id,
    sensitive: post.sensitive ?? false,
    name: post.name?.toString(),
    summary: post.summary?.toString(),
    contentHtml,
    language: post.content instanceof LanguageString
      ? post.content.locale.toString()
      : post.contents.length > 1 && post.contents[1] instanceof LanguageString
      ? post.contents[1].locale.toString()
      : undefined,
    tags,
    emojis,
    linkId: link?.id ?? null,
    linkUrl: link == null
      ? null
      : articleNewsLink != null
      ? articleNewsLink.url
      : externalLinks[0].hash === ""
      ? link.url
      : new URL(externalLinks[0].hash, link.url).href,
    url: postUrl,
    replyTargetId: replyTarget?.id,
    quotedPostId: quotedPost?.id ?? null,
    quoteAuthorizationIri: quoteAuthorizationIri ?? null,
    quoteTargetState,
    repliesCount: replies?.totalItems ?? 0,
    sharesCount: shares?.totalItems ?? 0,
    updated: toDate(post.updated ?? post.published) ?? undefined,
    published: toDate(post.published) ?? undefined,
  };
  const {
    repliesCount: _repliesCount,
    sharesCount: _sharesCount,
    ...updateSet
  } = values;
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.iri,
      set: updateSet,
      setWhere: eq(postTable.iri, post.id.href),
    })
    .returning();
  const persistedPost = { ...rows[0], actor };
  await createTargetPostUpdatedNotifications(
    db,
    existingPost,
    persistedPost,
    actor,
  );
  if (quoteAuthorizationIri != null && quotedPost != null) {
    await db.insert(quoteAuthorizationTable).values({
      id: generateUuidV7(),
      iri: quoteAuthorizationIri,
      quotePostIri: persistedPost.iri,
      quotePostId: persistedPost.id,
      quotedPostId: quotedPost.id,
      attributedActorId: quotedPost.actorId,
    }).onConflictDoUpdate({
      target: quoteAuthorizationTable.iri,
      set: {
        quotePostIri: persistedPost.iri,
        quotePostId: persistedPost.id,
        quotedPostId: quotedPost.id,
        attributedActorId: quotedPost.actorId,
        revoked: false,
        updated: sql`CURRENT_TIMESTAMP`,
      },
    });
  }
  await db.delete(mentionTable).where(
    eq(mentionTable.postId, persistedPost.id),
  );

  if (
    existingPost?.quotedPostId != null &&
    existingPost.quotedPostId !== quotedPost?.id
  ) {
    const previousQuotedPost = await db.query.postTable.findFirst({
      where: { id: existingPost.quotedPostId },
    });
    if (previousQuotedPost != null) {
      await updateQuotesCount(db, previousQuotedPost, -1);
    }
  }
  if (quotedPost != null && existingPost?.quotedPostId !== quotedPost.id) {
    await updateQuotesCount(db, quotedPost, 1);
  }
  let mentionList: (Mention & { actor: Actor })[] = [];
  const mentionsResult = mentionedActors.length > 0
    ? await db.insert(mentionTable)
      .values(
        mentionedActors.map((actor) => ({
          postId: persistedPost.id,
          actorId: actor.id,
        })),
      )
      .onConflictDoNothing()
      .returning()
      .execute()
    : [];
  mentionList = mentionsResult.map((m) => ({
    ...m,
    actor: mentionedActors.find((a) => a.id === m.actorId)!,
  }));
  await db.delete(postMediumTable).where(
    eq(postMediumTable.postId, persistedPost.id),
  );
  let i = 0;
  for (const attachment of attachments) {
    await persistPostMedium(ctx, attachment, persistedPost.id, i);
    i++;
  }
  if (options.replies && depth === 0 && replies != null) {
    const totalItems = replies.totalItems ?? 0;
    const canInlineReplies = totalItems < 1 ||
      totalItems <= inlineRepliesThreshold;
    if (canInlineReplies) {
      let repliesCount = 0;
      const traversalDeadline = Date.now() + INLINE_REPLIES_TRAVERSAL_BUDGET_MS;
      const repliesIterator = traverseCollection(replies, opts)[
        Symbol.asyncIterator
      ]();
      while (repliesCount < maxReplies) {
        let result: Awaited<ReturnType<typeof repliesIterator.next>>;
        try {
          result = await repliesIterator.next();
        } catch (error) {
          logger.debug(
            "Inline replies traversal for {postIri} failed after " +
              "{repliesCount} replies; keeping the parent post.",
            { postIri: persistedPost.iri, repliesCount, error },
          );
          break;
        }
        if (result.done) break;
        if (Date.now() >= traversalDeadline) {
          logger.debug(
            "Inline replies traversal for {postIri} hit the {budgetMs}ms " +
              "budget after {repliesCount} replies; stopping early to stay " +
              "under the message handler timeout.",
            {
              postIri: persistedPost.iri,
              budgetMs: INLINE_REPLIES_TRAVERSAL_BUDGET_MS,
              repliesCount,
            },
          );
          break;
        }
        const reply = result.value;
        if (!isPostObject(reply)) continue;
        await persistPost(ctx, reply, {
          ...options,
          actor,
          replyTarget: persistedPost,
          replies: false,
          depth: depth + 1,
          signal: overallSignal,
        });
        repliesCount++;
      }
      if (persistedPost.repliesCount < repliesCount) {
        await db.update(postTable)
          .set({
            repliesCount:
              sql`GREATEST(${postTable.repliesCount}, ${repliesCount})`,
          })
          .where(eq(postTable.id, persistedPost.id));
        persistedPost.repliesCount = Math.max(
          persistedPost.repliesCount,
          repliesCount,
        );
      }
    } else if (deferLargeReplies) {
      const lockKey = `reply-backfill/${persistedPost.iri}`;
      const [locked] = await ctx.data.kv.getMany<string>([lockKey]);
      if (locked !== "1") {
        // Best-effort dedupe lock: avoid spawning multiple backfills for
        // the same post during bursty inbox traffic.
        await ctx.data.kv.set(lockKey, "1", REPLIES_BACKFILL_LOCK_TTL_SECONDS);
        void (async () => {
          // This runs in the background after the handler returns, so it must
          // NOT inherit the handler's overall deadline (`opts` is bound to
          // `overallSignal`).  Give it a loader with only the per-fetch timeout
          // so a long backfill is not truncated at the synchronous handler's
          // budget; each backfilled reply still gets its own fresh overall
          // budget via the `persistPost` call below (which omits `signal`).
          const backfillOpts = {
            contextLoader: options.contextLoader,
            documentLoader: withDocumentLoaderTimeout(
              options.documentLoader ?? ctx.documentLoader,
            ),
            suppressError: true,
          };
          const persistReply = async (
            attempt: number,
          ): Promise<void> => {
            try {
              let count = 0;
              for await (
                const reply of traverseCollection(replies, backfillOpts)
              ) {
                if (count >= maxReplies) break;
                if (!isPostObject(reply)) continue;
                await persistPost(ctx, reply, {
                  ...options,
                  actor,
                  replyTarget: persistedPost,
                  replies: false,
                  depth: depth + 1,
                  // Don't inherit a caller's top-level deadline (`...options`
                  // may carry one); each backfilled reply mints its own fresh
                  // budget so the background batch isn't cut off by the
                  // originating handler's deadline.
                  signal: undefined,
                });
                count++;
              }
              if (persistedPost.repliesCount < count) {
                await db.update(postTable)
                  .set({
                    repliesCount:
                      sql`GREATEST(${postTable.repliesCount}, ${count})`,
                  })
                  .where(eq(postTable.id, persistedPost.id));
                persistedPost.repliesCount = Math.max(
                  persistedPost.repliesCount,
                  count,
                );
              }
            } catch (error) {
              if (attempt < 1) {
                // Single delayed retry to absorb transient federation failures
                // without introducing a durable queue.
                await new Promise((resolve) =>
                  setTimeout(resolve, REPLIES_BACKFILL_RETRY_DELAY_MS)
                );
                await persistReply(attempt + 1);
                return;
              }
              logger.warn(
                "Failed to backfill replies for {postIri} after retry: {error}",
                { postIri: persistedPost.iri, error },
              );
            }
          };
          await persistReply(0);
        })().catch((error) => {
          logger.warn("Replies backfill task failed for {postIri}: {error}", {
            postIri: persistedPost.iri,
            error,
          });
        });
      }
    }
  }
  let poll: Poll | undefined;
  if (post instanceof vocab.Question) {
    poll = await persistPoll(db, post, persistedPost.id);
  }
  // Only refresh at the top level: recursive reply backfill (depth > 0) would
  // re-score the same story once per reply; the periodic sweep covers those.
  if (depth === 0) {
    await refreshNewsScores(db, [persistedPost.linkId, existingPost?.linkId]);
  }
  return {
    ...persistedPost,
    replyTarget: replyTarget ?? null,
    quotedPost: quotedPost ?? null,
    mentions: mentionList,
    poll: poll ?? null,
  };
}

export async function persistSharedPost(
  ctx: Context<ContextData>,
  announce: vocab.Announce,
  options: {
    actor?: Actor & { instance: Instance };
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
    /**
     * Shared overall deadline for the whole operation.  When provided by the
     * caller (e.g. an inbox handler that already minted one), getActor(),
     * getObject(), and the internal persistPost() all share this signal so
     * their aggregate cannot exceed the message-queue handler timeout.  When
     * omitted, a fresh budget of PERSIST_POST_OVERALL_BUDGET_MS is minted.
     */
    signal?: AbortSignal;
  } = {},
): Promise<
  Post & {
    actor: Actor & { instance: Instance };
    sharedPost: Post & { actor: Actor & { instance: Instance } };
  } | undefined
> {
  if (announce.id == null || announce.actorId == null) {
    logger.debug(
      "Missing required fields (id, actor): {announce}",
      { announce },
    );
    return;
  }
  const { db } = ctx.data;
  // One deadline for this entire operation.  Reuse the caller's signal when
  // available so pre-persistPost fetches (getActor, getObject) and the
  // persistPost subtree are all capped by the same wall-clock budget.
  const overallSignal = options.signal ??
    AbortSignal.timeout(PERSIST_POST_OVERALL_BUDGET_MS);
  const boundedOpts = {
    contextLoader: options.contextLoader,
    documentLoader: withDocumentLoaderTimeout(
      options.documentLoader ?? ctx.documentLoader,
      REMOTE_FETCH_TIMEOUT_MS,
      overallSignal,
    ),
    suppressError: true,
  };
  let actor: Actor & { instance: Instance } | undefined =
    options.actor == null || options.actor.iri !== announce.actorId.href
      ? await getPersistedActor(db, announce.actorId)
      : options.actor;
  if (actor != null && isFederationBlocked(actor)) return;
  if (actor == null) {
    const apActor = await announce.getActor(boundedOpts);
    if (apActor == null) return;
    actor = await persistActor(ctx, apActor, boundedOpts);
    if (actor == null) return;
  }
  const object = await announce.getObject(boundedOpts);
  if (!isPostObject(object)) return;
  const post = await persistPost(ctx, object, {
    ...options,
    replies: true,
    signal: overallSignal,
  });
  if (post == null) return;
  // A censored post cannot be re-amplified via a federated boost, mirroring
  // the local sharePost() guard: drop the Announce instead of inserting a
  // wrapper that timelines and the share notification would surface.
  if (post.censored != null) return;
  const to = new Set(announce.toIds.map((u) => u.href));
  const cc = new Set(announce.ccIds.map((u) => u.href));
  const values: Omit<NewPost, "id"> = {
    iri: announce.id.href,
    type: post.type,
    visibility: to.has(PUBLIC_COLLECTION.href)
      ? "public"
      : cc.has(PUBLIC_COLLECTION.href)
      ? "unlisted"
      : actor.followersUrl != null &&
          (to.has(actor.followersUrl) || cc.has(actor.followersUrl))
      ? "followers"
      : "none",
    actorId: actor.id,
    sharedPostId: post.id,
    name: post.name,
    contentHtml: post.contentHtml,
    language: post.language,
    tags: {},
    emojis: post.emojis,
    sensitive: post.sensitive,
    url: post.url,
    updated: toDate(announce.updated ?? announce.published) ?? undefined,
    published: toDate(announce.published) ?? undefined,
  };
  const id = generateUuidV7();
  const rows = await db.insert(postTable)
    .values({ id, ...values })
    .onConflictDoUpdate({
      target: [postTable.actorId, postTable.sharedPostId],
      set: values,
      setWhere: and(
        eq(postTable.actorId, actor.id),
        eq(postTable.sharedPostId, post.id),
      ),
    })
    .returning();
  if (rows.length < 1) return undefined;
  if (rows[0].id === id) await updateSharesCount(db, post, 1);
  await refreshNewsScores(db, [post.type === "Article" ? post.linkId : null]);
  return { ...rows[0], actor, sharedPost: post };
}

async function getOriginalSharedPost(
  db: Database,
  post: Post & { actor: Actor },
): Promise<Post & { actor: Actor }> {
  if (post.sharedPostId == null) return post;

  const visited = new Set<Uuid>([post.id]);
  let currentId: Uuid | null = post.sharedPostId;
  while (currentId != null) {
    if (visited.has(currentId)) return post;
    visited.add(currentId);

    const current: Pick<Post, "id" | "sharedPostId"> | undefined = await db
      .query.postTable.findFirst({
        columns: { id: true, sharedPostId: true },
        where: { id: currentId },
      });
    if (current == null) return post;
    if (current.sharedPostId == null) {
      const original = await db.query.postTable.findFirst({
        with: { actor: true },
        where: { id: current.id },
      });
      return original ?? post;
    }
    currentId = current.sharedPostId;
  }

  return post;
}

async function canPersistIncomingQuote(
  db: Database,
  quotedPostId: Uuid,
  actor: Actor,
): Promise<boolean> {
  const quotedPost = await db.query.postTable.findFirst({
    with: {
      actor: {
        with: {
          followers: { where: { followerId: actor.id } },
          blockees: { where: { blockeeId: actor.id } },
          blockers: { where: { blockerId: actor.id } },
        },
      },
      mentions: { where: { actorId: actor.id } },
    },
    where: { id: quotedPostId },
  });
  // Quote *policy* only; the censored (moderation) gate lives at the caller so
  // it also applies to the quote-authorization path, which legitimately
  // overrides policy but must never override censorship.
  return quotedPost != null && canActorQuotePost(quotedPost, actor);
}

async function getPersistedQuoteTargetState(
  db: Database,
  quotePostId: Uuid,
  quotedPostId: Uuid,
): Promise<Post["quoteTargetState"]> {
  const pendingRequests = await db.select({ id: quoteRequestTable.id })
    .from(quoteRequestTable)
    .where(and(
      eq(quoteRequestTable.quotePostId, quotePostId),
      eq(quoteRequestTable.quotedPostId, quotedPostId),
      isNull(quoteRequestTable.accepted),
      isNull(quoteRequestTable.rejected),
    ))
    .limit(1);
  if (pendingRequests.length > 0) return "pending";

  const deniedRequests = await db.select({ id: quoteRequestTable.id })
    .from(quoteRequestTable)
    .where(and(
      eq(quoteRequestTable.quotePostId, quotePostId),
      eq(quoteRequestTable.quotedPostId, quotedPostId),
      isNotNull(quoteRequestTable.rejected),
    ))
    .limit(1);
  if (deniedRequests.length > 0) return "denied";

  const revokedAuthorizations = await db.select({
    id: quoteAuthorizationTable.id,
  })
    .from(quoteAuthorizationTable)
    .where(and(
      eq(quoteAuthorizationTable.quotePostId, quotePostId),
      eq(quoteAuthorizationTable.quotedPostId, quotedPostId),
      eq(quoteAuthorizationTable.revoked, true),
    ))
    .limit(1);
  return revokedAuthorizations.length > 0 ? "denied" : null;
}

async function getOriginalQuoteTarget(
  db: Database,
  post: PersistedQuoteTarget,
): Promise<PersistedQuoteTarget | undefined> {
  const originalPostId = await getOriginalPostId(db, post);
  if (originalPostId == null) return undefined;
  if (originalPostId === post.id) return post;
  return await db.query.postTable.findFirst({
    with: {
      actor: {
        with: { instance: true },
      },
    },
    where: { id: originalPostId },
  });
}

export async function sharePost(
  fedCtx: Context<ContextData>,
  account: Account & {
    avatarMedium: Medium | null;
    emails: AccountEmail[];
    links: AccountLink[];
  },
  post: Post & { actor: Actor },
  visibility?: PostVisibility,
): Promise<Post> {
  const { db } = fedCtx.data;
  await assertAccountActorNotSuspended(db, account.id);
  const sharedPost = await getOriginalSharedPost(db, post);
  // Callers reject censored targets with a proper response; this is a
  // backstop so no future caller can boost (and thus re-amplify and
  // copy into the wrapper) moderation-hidden content.
  if (post.censored != null || sharedPost.censored != null) {
    throw new TypeError("A censored post cannot be shared.");
  }
  const actor = await syncActorFromAccount(fedCtx, account);
  const id = generateUuidV7();
  const posts = await db.insert(postTable).values({
    id,
    iri: fedCtx.getObjectUri(vocab.Announce, { id }).href,
    type: sharedPost.type,
    visibility: visibility || account.shareVisibility,
    actorId: actor.id,
    sharedPostId: sharedPost.id,
    name: sharedPost.name,
    contentHtml: sharedPost.contentHtml,
    language: sharedPost.language,
    tags: {},
    emojis: sharedPost.emojis,
    sensitive: sharedPost.sensitive,
    url: sharedPost.url,
  }).onConflictDoNothing().returning();
  if (posts.length < 1) {
    const share = await db.query.postTable.findFirst({
      where: {
        actorId: actor.id,
        sharedPostId: sharedPost.id,
      },
    });
    return share!;
  }
  const share = posts[0];
  sharedPost.sharesCount = await updateSharesCount(db, sharedPost, 1);
  share.sharesCount = sharedPost.sharesCount;
  await refreshNewsScores(db, [
    sharedPost.type === "Article" ? sharedPost.linkId : null,
  ]);
  await addPostToTimeline(db, share);

  // Create a share notification for the original post's author
  if (sharedPost.actor.accountId != null) {
    const notification = await createShareNotification(
      db,
      sharedPost.actor.accountId,
      sharedPost,
      actor,
      share.published,
    );
    logger.debug("Created share notification for {accountId}: {notification}", {
      accountId: sharedPost.actor.accountId,
      notification,
    });
  }
  const announce = getAnnounce(fedCtx, {
    ...share,
    sharedPost,
    actor: { ...actor, account },
    mentions: [],
  });
  await fedCtx.sendActivity(
    { identifier: account.id },
    "followers",
    announce,
    {
      orderingKey: share.iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  await fedCtx.sendActivity(
    { identifier: account.id },
    toRecipient(sharedPost.actor),
    announce,
    {
      orderingKey: share.iri,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  return share;
}

export async function unsharePost(
  fedCtx: Context<ContextData>,
  account: Account & {
    avatarMedium: Medium | null;
    emails: AccountEmail[];
    links: AccountLink[];
  },
  sharedPost: Post & { actor: Actor },
): Promise<Post | undefined> {
  const { db } = fedCtx.data;
  const originalPost = await getOriginalSharedPost(db, sharedPost);
  if (originalPost.sharedPostId != null) return;
  const actor = await syncActorFromAccount(fedCtx, account);
  const unshared = await db.delete(postTable).where(
    and(
      eq(postTable.actorId, actor.id),
      eq(postTable.sharedPostId, originalPost.id),
    ),
  ).returning();
  if (unshared.length < 1) return undefined;
  originalPost.sharesCount = await updateSharesCount(db, originalPost, -1);
  await refreshNewsScores(db, [
    originalPost.type === "Article" ? originalPost.linkId : null,
  ]);
  await removeFromTimeline(db, unshared[0]);
  if (originalPost.actor.accountId != null) {
    await deleteShareNotification(
      db,
      originalPost.actor.accountId,
      originalPost,
      actor,
    );
  }
  const announce = getAnnounce(fedCtx, {
    ...unshared[0],
    actor,
    sharedPost: originalPost,
    mentions: [],
  });
  const undo = new vocab.Undo({
    actor: fedCtx.getActorUri(account.id),
    object: announce,
    tos: announce.toIds,
    ccs: announce.ccIds,
  });
  await fedCtx.sendActivity(
    { identifier: account.id },
    "followers",
    undo,
    {
      orderingKey: unshared[0].iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  await fedCtx.sendActivity(
    { identifier: account.id },
    toRecipient(originalPost.actor),
    undo,
    {
      orderingKey: unshared[0].iri,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  return unshared[0];
}

export async function arePostsSharedBy(
  db: Database,
  postIds: readonly Uuid[],
  account: Account & { actor: Actor },
): Promise<Set<Uuid>> {
  if (postIds.length < 1) return new Set();
  const rows = await db.select({ sharedPostId: postTable.sharedPostId })
    .from(postTable)
    .where(
      and(
        eq(postTable.actorId, account.actor.id),
        inArray(postTable.sharedPostId, postIds as Uuid[]),
      ),
    );
  const result = new Set<Uuid>();
  for (const row of rows) {
    if (row.sharedPostId != null) result.add(row.sharedPostId);
  }
  return result;
}

export function getPersistedPost(
  db: Database,
  iri: URL,
): Promise<
  | Post & {
    actor: Actor & { instance: Instance };
    mentions: (Mention & { actor: Actor })[];
    replyTarget: Post & { actor: Actor } | null;
    quotedPost: Post & { actor: Actor } | null;
    poll: Poll | null;
  }
  | undefined
> {
  return db.query.postTable.findFirst({
    with: {
      actor: {
        with: { instance: true },
      },
      mentions: {
        with: { actor: true },
      },
      replyTarget: {
        with: { actor: true },
      },
      quotedPost: {
        with: { actor: true },
      },
      poll: true,
    },
    where: {
      iri: iri.href,
    },
  });
}

export function getPostByUsernameAndId(
  db: Database,
  username: string,
  id: Uuid,
  signedAccount: Account & { actor: Actor } | undefined,
): Promise<
  | Post & {
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
              followers: (Following & { follower: Actor })[];
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
          followers: (Following & { follower: Actor })[];
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
  | undefined
> {
  if (!username.includes("@")) return Promise.resolve(undefined);
  let host: string;
  [username, host] = username.split("@");
  return db.query.postTable.findFirst({
    with: {
      actor: {
        with: {
          instance: true,
          followers: true,
          blockees: true,
          blockers: true,
        },
      },
      link: { with: { creator: true } },
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
          replyTarget: {
            with: {
              actor: {
                with: {
                  instance: true,
                  followers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { followerId: signedAccount.actor.id },
                    with: { follower: true },
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
        },
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
                with: { follower: true },
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
    },
    where: {
      id,
      actor: {
        username,
        OR: [
          { instanceHost: host },
          { handleHost: host },
        ],
      },
    },
  });
}

export async function deletePersistedPost(
  db: Database,
  iri: URL,
  actorIri: URL,
): Promise<boolean> {
  const deletedPosts = await db.delete(postTable).where(
    and(
      eq(postTable.iri, iri.toString()),
      inArray(
        postTable.actorId,
        db.select({ id: actorTable.id })
          .from(actorTable)
          .where(eq(actorTable.iri, actorIri.toString())),
      ),
      isNull(postTable.sharedPostId),
    ),
  ).returning();
  if (deletedPosts.length < 1) return false;
  const [deletedPost] = deletedPosts;
  if (deletedPost.replyTargetId != null) {
    const replyTarget = await db.query.postTable.findFirst({
      where: { id: deletedPost.replyTargetId },
    });
    if (replyTarget != null) await updateRepliesCount(db, replyTarget, -1);
  }
  if (deletedPost.quotedPostId != null) {
    const quotedPost = await db.query.postTable.findFirst({
      where: { id: deletedPost.quotedPostId },
    });
    if (quotedPost != null) await updateQuotesCount(db, quotedPost, -1);
  }
  // Re-score the link this post shared and the links of the posts it replied
  // to / quoted (their public reply/quote count dropped).
  await refreshNewsScoresForPostLinks(db, deletedPost);
  return true;
}

export async function deleteSharedPost(
  db: Database,
  iri: URL,
  actorIri: URL,
): Promise<Post & { actor: Actor } | undefined> {
  const actor = await db.query.actorTable.findFirst({
    where: { iri: actorIri.toString() },
  });
  if (actor == null) return undefined;
  const shares = await db.delete(postTable).where(
    and(
      eq(postTable.iri, iri.toString()),
      eq(postTable.actorId, actor.id),
      isNotNull(postTable.sharedPostId),
    ),
  ).returning();
  if (shares.length < 1) return undefined;
  const [share] = shares;
  if (share.sharedPostId == null) return undefined;
  const sharedPost = await db.query.postTable.findFirst({
    where: { id: share.sharedPostId },
  });
  if (sharedPost == null) return { ...share, actor };
  await updateSharesCount(db, sharedPost, -1);
  await refreshNewsScores(db, [
    sharedPost.type === "Article" ? sharedPost.linkId : null,
  ]);
  return { ...share, actor };
}

export function isPostVisibleTo(
  post: Post & {
    actor: Actor & {
      followers: Following[];
      blockees: Blocking[];
      blockers: Blocking[];
    };
    mentions: Mention[];
  },
  actor?: Actor,
): boolean;
export function isPostVisibleTo(
  post: Post & {
    actor: Actor & {
      followers: (Following & { follower: Actor })[];
      blockees: (Blocking & { blockee: Actor })[];
      blockers: (Blocking & { blocker: Actor })[];
    };
    mentions: (Mention & { actor: Actor })[];
  },
  actor?: { iri: string },
): boolean;
export function isPostVisibleTo(
  post: Post & {
    actor: Actor & {
      followers: (Following & { follower?: Actor })[];
      blockees: (Blocking & { blockee?: Actor })[];
      blockers: (Blocking & { blocker?: Actor })[];
    };
    mentions: (Mention & { actor?: Actor })[];
    sharedPost?: (Post & { actor: Actor }) | null;
  },
  actor?: Actor | { iri: string },
): boolean {
  // A share wrapper's visibility depends on the boosted post (its author's
  // block and sanction state, which the booster's actor does not carry).
  // When the boosted post was not loaded, that cannot be evaluated, so fail
  // closed rather than let a wrapper of a hidden post pass on the booster
  // alone (e.g. an interaction resolver that has only a wrapper id).
  if (post.sharedPostId != null && post.sharedPost === undefined) return false;
  // A share wrapper denormalizes the boosted post's content, so a boost
  // of a sanction-hidden actor's post is hidden too (when the relation
  // is loaded).  Checked before the wrapper-author fast path: only the
  // boosted post's author keeps access, not the booster.
  if (post.sharedPost?.actor != null) {
    const sharedAuthor = post.sharedPost.actor;
    const viewerIsSharedAuthor = actor != null && (
      "id" in actor
        ? sharedAuthor.id === actor.id
        : sharedAuthor.iri === actor.iri
    );
    if (!viewerIsSharedAuthor && isActorSanctionHidden(sharedAuthor)) {
      return false;
    }
  }
  if (actor != null) {
    if (
      "id" in actor && post.actor.id === actor.id ||
      "iri" in actor && post.actor.iri === actor.iri
    ) {
      return true;
    }
  }
  if (isActorSanctionHidden(post.actor)) return false;
  if (actor != null) {
    const blocked = "id" in actor
      ? post.actor.blockees.some((b) => b.blockeeId === actor.id) ||
        post.actor.blockers.some((b) => b.blockerId === actor.id)
      : post.actor.blockees.some((b) => b.blockee?.iri === actor.iri) ||
        post.actor.blockers.some((b) => b.blocker?.iri === actor.iri);
    if (blocked) return false;
  }
  if (post.visibility === "public" || post.visibility === "unlisted") {
    return true;
  }
  if (actor == null) return false;
  if (post.visibility === "followers") {
    if ("id" in actor) {
      return post.actor.followers.some((follower) =>
        follower.followerId === actor.id && follower.accepted != null
      ) || post.mentions.some((mention) => mention.actorId === actor.id);
    } else {
      return post.actor.followers.some((follower) =>
        follower.follower?.iri === actor.iri && follower.accepted != null
      ) || post.mentions.some((mention) => mention.actor?.iri === actor.iri);
    }
  }
  if (post.visibility === "direct") {
    if ("id" in actor) {
      return post.mentions.some((mention) => mention.actorId === actor.id);
    } else {
      return post.mentions.some((mention) => mention.actor?.iri === actor.iri);
    }
  }
  return false;
}

export interface PostInteractionPolicy {
  readonly canReply: boolean;
  readonly canQuote: boolean;
  readonly canShare: boolean;
}

const DENY_ALL: PostInteractionPolicy = {
  canReply: false,
  canQuote: false,
  canShare: false,
};

export async function getPostInteractionPolicies(
  db: Database,
  postIds: readonly Uuid[],
  viewer: Actor | null,
): Promise<Map<Uuid, PostInteractionPolicy>> {
  const result = new Map<Uuid, PostInteractionPolicy>();
  for (const id of postIds) result.set(id, DENY_ALL);
  if (postIds.length < 1 || viewer == null) return result;

  // Filter each viewer-relevant relation down to the viewer's row only.
  // `isPostVisibleTo` just checks `.some(... === viewer.id ...)`, so loading
  // the full follower/blockee/blocker/mention sets for popular actors is
  // wasteful — at most one row per relation actually matters.
  const posts = await db.query.postTable.findMany({
    with: {
      actor: {
        with: {
          followers: { where: { followerId: viewer.id } },
          blockees: { where: { blockeeId: viewer.id } },
          blockers: { where: { blockerId: viewer.id } },
        },
      },
      mentions: { where: { actorId: viewer.id } },
      sharedPost: {
        with: {
          actor: {
            with: {
              followers: { where: { followerId: viewer.id } },
              blockees: { where: { blockeeId: viewer.id } },
              blockers: { where: { blockerId: viewer.id } },
            },
          },
          mentions: { where: { actorId: viewer.id } },
        },
      },
    },
    where: {
      id: { in: postIds as Uuid[] },
    },
  });

  for (const post of posts) {
    if (!isPostVisibleTo(post, viewer)) continue;
    const effective = post.sharedPost ?? post;
    // A censored post (or a wrapper of one) cannot be boosted or quoted by
    // anyone, including its author or a moderator: both actions re-amplify
    // moderation-hidden content, and the share/quote mutations reject them
    // outright.  Deny the policy too so the UI never offers an affordance
    // that is guaranteed to fail.
    const censored = post.censored != null || effective.censored != null;
    const canAmplify = !censored && effective.sharedPostId == null &&
      isPostVisibleTo(effective, viewer) && (
        effective.visibility === "public" ||
        effective.visibility === "unlisted" ||
        (effective.visibility === "followers" &&
          effective.actorId === viewer.id)
      );
    const canQuote = !censored && effective.sharedPostId == null &&
      isPostVisibleTo(effective, viewer) &&
      canActorRequestQuotePost(effective, viewer);
    result.set(post.id, {
      canReply: true,
      canQuote,
      canShare: canAmplify,
    });
  }
  return result;
}

/**
 * Builds a post filter that excludes posts whose author (or whose shared
 * original's author) is muted by the given muter.  The `sharedPost` clause
 * matters for the public timeline, where shares are wrapper posts: it hides a
 * muted author's content even when an unmuted account boosts it.  (In the
 * personal timeline `post_id` always points at the underlying post, so the
 * `sharedPost` clause is a harmless no-op there; muted *sharers* are handled
 * separately via `timeline_item.last_sharer_id`.)
 *
 * Unlike {@link getActorContentExclusionFilter} (used for blocking), this is
 * intentionally NOT folded into {@link getPostVisibilityFilter}: muting must
 * only hide content from feeds, not from the muted actor's own profile or from
 * thread views.  Apply it explicitly in feed queries.
 */
export function getMutedActorExclusionFilter(
  muterActorId: Uuid,
): RelationsFilter<"postTable"> {
  return {
    actor: { NOT: { muters: { muterId: muterActorId } } },
    NOT: { sharedPost: { actor: { muters: { muterId: muterActorId } } } },
  } satisfies RelationsFilter<"postTable">;
}

/**
 * Builds a post filter that excludes censored posts (and boosts of censored
 * posts) from feed-like surfaces: timelines, search, news, and profile post
 * lists.  Like {@link getMutedActorExclusionFilter}, this is intentionally
 * NOT folded into {@link getPostVisibilityFilter}: a censored post's
 * permalink must remain reachable so it can show a censorship notice
 * instead of disappearing with a 404.  Apply it explicitly in list queries.
 *
 * When `viewerActorId` is given, the viewer's own censored posts stay
 * visible to them ("author can still view their own content").
 */
export function getCensoredPostExclusionFilter(
  viewerActorId?: Uuid | null,
): RelationsFilter<"postTable"> {
  return {
    ...(viewerActorId == null ? { censored: { isNull: true } } : {
      OR: [
        { censored: { isNull: true } },
        { actorId: viewerActorId },
      ],
    }),
    NOT: { sharedPost: { censored: { isNotNull: true } } },
  } satisfies RelationsFilter<"postTable">;
}

/**
 * Matches actors whose content is currently hidden by a moderation
 * sanction: banned local actors (permanent suspension) and remote actors
 * under an active federation block (temporary or permanent).  A
 * *temporarily* suspended local actor's content stays visible; only their
 * ability to write is restricted.
 *
 * Sanction activeness is always evaluated by time comparison against the
 * given instant, so expired suspensions need no cleanup writes.
 *
 * This is a *positive* matcher; it is only safe to negate at the relation
 * level (`NOT: { sharedPost: { actor: ... } }` compiles to `NOT EXISTS`).
 * Negating it directly on an actor row would trip SQL's three-valued
 * logic: for unsanctioned actors `suspended` is `NULL`, the comparison
 * evaluates to `NULL`, and `NOT NULL` is still `NULL`, filtering the row
 * out.  Use {@link getSanctionVisibleActorFilter} for the inclusion form.
 */
export function getSanctionHiddenActorFilter(
  now: Date = new Date(),
): RelationsFilter<"actorTable"> {
  return {
    suspended: { lte: now },
    OR: [
      // Remote actor under an active federation block:
      { accountId: { isNull: true }, suspendedUntil: { isNull: true } },
      { accountId: { isNull: true }, suspendedUntil: { gt: now } },
      // Banned local actor:
      { accountId: { isNotNull: true }, suspendedUntil: { isNull: true } },
    ],
  } satisfies RelationsFilter<"actorTable">;
}

/**
 * The TypeScript-side counterpart of {@link getSanctionHiddenActorFilter}:
 * whether the actor's content is currently hidden by a moderation sanction
 * (banned local actor, or remote actor under an active federation block).
 */
export function isActorSanctionHidden(
  actor: Pick<Actor, "accountId" | "suspended" | "suspendedUntil">,
  now: Date = new Date(),
): boolean {
  if (actor.suspended == null || actor.suspended > now) return false;
  if (actor.suspendedUntil != null && actor.suspendedUntil <= now) {
    return false; // Expired.
  }
  // An active *temporary* suspension of a local actor only restricts
  // writing; a permanent one (ban), or any active sanction on a remote
  // actor (federation block), hides content.
  return actor.accountId == null || actor.suspendedUntil == null;
}

/**
 * The NULL-safe inclusion complement of
 * {@link getSanctionHiddenActorFilter}: matches actors whose content is
 * NOT hidden by a moderation sanction, including the common case where
 * `suspended` is `NULL`.
 */
export function getSanctionVisibleActorFilter(
  now: Date = new Date(),
): RelationsFilter<"actorTable"> {
  return {
    OR: [
      // Not sanctioned at all:
      { suspended: { isNull: true } },
      // Sanction not started yet:
      { suspended: { gt: now } },
      // Sanction already expired:
      { suspendedUntil: { lte: now } },
      // Active temporary suspension of a *local* actor only restricts
      // writing; their content stays visible:
      { accountId: { isNotNull: true }, suspendedUntil: { gt: now } },
    ],
  } satisfies RelationsFilter<"actorTable">;
}

function getActorContentExclusionFilter(
  actorId: Uuid,
): RelationsFilter<"actorTable"> {
  return {
    AND: [
      {
        NOT: {
          OR: [
            { blockees: { blockeeId: actorId } },
            { blockers: { blockerId: actorId } },
          ],
        },
      },
      getSanctionVisibleActorFilter(),
    ],
  } satisfies RelationsFilter<"actorTable">;
}

export function getPostVisibilityFilter(
  actor: Actor | null,
): RelationsFilter<"postTable">;
export function getPostVisibilityFilter(
  actor: Post,
): RelationsFilter<"actorTable">;

export function getPostVisibilityFilter(
  actorOrPost: Actor | Post | null,
): RelationsFilter<"postTable"> | RelationsFilter<"actorTable"> {
  if (actorOrPost == null) {
    return {
      visibility: { in: ["public", "unlisted"] },
      actor: getSanctionVisibleActorFilter(),
      NOT: { sharedPost: { actor: getSanctionHiddenActorFilter() } },
    } satisfies RelationsFilter<"postTable">;
  }
  if ("accountId" in actorOrPost) {
    return {
      actor: getActorContentExclusionFilter(actorOrPost.id),
      NOT: { sharedPost: { actor: getSanctionHiddenActorFilter() } },
      OR: [
        { actorId: actorOrPost.id },
        { visibility: { in: ["public", "unlisted"] } },
        { mentions: { actorId: actorOrPost.id } },
        {
          visibility: "followers",
          actor: {
            followers: {
              followerId: actorOrPost.id,
              accepted: { isNotNull: true },
            },
          },
        },
      ],
    } satisfies RelationsFilter<"postTable">;
  } else {
    if (
      actorOrPost.visibility === "public" ||
      actorOrPost.visibility === "unlisted"
    ) {
      return getActorContentExclusionFilter(actorOrPost.actorId);
    }
    return {
      AND: [
        getActorContentExclusionFilter(actorOrPost.actorId),
        {
          OR: [
            { id: actorOrPost.actorId },
            { mentions: { postId: actorOrPost.id } },
            ...(actorOrPost.visibility === "followers"
              ? [{
                followees: {
                  followeeId: actorOrPost.actorId,
                  accepted: { isNotNull: true },
                } satisfies RelationsFilter<"followingTable">,
              }]
              : []),
          ],
        },
      ],
    } satisfies RelationsFilter<"actorTable">;
  }
}

export function getPublicTimelineVisibilityFilter(
  actor: Actor | null,
): RelationsFilter<"postTable"> {
  if (actor == null) {
    return {
      visibility: "public",
      actor: getSanctionVisibleActorFilter(),
      NOT: { sharedPost: { actor: getSanctionHiddenActorFilter() } },
    } satisfies RelationsFilter<"postTable">;
  }
  return {
    actor: getActorContentExclusionFilter(actor.id),
    NOT: { sharedPost: { actor: getSanctionHiddenActorFilter() } },
    visibility: "public",
  } satisfies RelationsFilter<"postTable">;
}

export async function updateRepliesCount(
  db: Database,
  replyTarget: Post,
  delta: number,
): Promise<number | undefined> {
  const repliesCount = replyTarget.repliesCount + delta;
  const cnt = await db.select({ count: count() })
    .from(postTable)
    .where(eq(postTable.replyTargetId, replyTarget.id));
  if (repliesCount <= cnt[0].count) {
    await db.update(postTable)
      .set({ repliesCount: cnt[0].count })
      .where(eq(postTable.id, replyTarget.id));
    replyTarget.repliesCount = cnt[0].count;
    return cnt[0].count;
  }
  return repliesCount;
}

export async function updateSharesCount(
  db: Database,
  post: Post,
  delta: number,
): Promise<number> {
  const sharesCount = post.sharesCount + delta;
  const cnt = await db.select({ count: count() })
    .from(postTable)
    .where(eq(postTable.sharedPostId, post.id));
  if (sharesCount <= cnt[0].count) {
    await db.update(postTable)
      .set({ sharesCount: cnt[0].count })
      .where(eq(postTable.id, post.id));
    post.sharesCount = cnt[0].count;
    return cnt[0].count;
  }
  return sharesCount;
}

export async function updateQuotesCount(
  db: Database | Transaction,
  post: Post,
  delta: number,
): Promise<number> {
  const quotesCount = post.quotesCount + delta;
  const cnt = await db.select({ count: count() })
    .from(postTable)
    .where(eq(postTable.quotedPostId, post.id));
  if (quotesCount <= cnt[0].count) {
    await db.update(postTable)
      .set({ quotesCount: cnt[0].count })
      .where(eq(postTable.id, post.id));
    post.quotesCount = cnt[0].count;
    return cnt[0].count;
  }
  return quotesCount;
}

export async function revokeQuote(
  fedCtx: Context<ContextData>,
  account: Account,
  quotePost: Post & { actor: Actor },
  quotedPost: Post,
): Promise<Post> {
  const { db } = fedCtx.data;
  const revokedAt = new Date();
  let updatedQuote: QuoteUpdatePost | undefined;
  const rows = await db.update(postTable)
    .set({
      quotedPostId: null,
      quoteAuthorizationIri: null,
      quoteTargetState: "denied",
      updated: revokedAt,
    })
    .where(and(
      eq(postTable.id, quotePost.id),
      eq(postTable.quotedPostId, quotedPost.id),
    ))
    .returning();
  const updatedPost = rows[0];
  if (updatedPost == null) {
    return await db.query.postTable.findFirst({
      where: { id: quotePost.id },
    }) ??
      quotePost;
  }
  if (quotePost.actor.accountId != null && quotePost.noteSourceId != null) {
    await db.update(noteSourceTable)
      .set({ updated: revokedAt })
      .where(eq(noteSourceTable.id, quotePost.noteSourceId));
    updatedQuote = await db.query.postTable.findFirst({
      with: {
        actor: true,
        quotedPost: { with: { actor: true } },
        replyTarget: true,
        mentions: { with: { actor: true } },
      },
      where: { id: quotePost.id },
    });
    if (updatedQuote != null) {
      await sendLocalQuoteUpdate(fedCtx, updatedQuote, null, revokedAt);
    }
  }
  if (quotePost.quoteAuthorizationIri != null) {
    await db.update(quoteAuthorizationTable)
      .set({ revoked: true, updated: revokedAt })
      .where(eq(quoteAuthorizationTable.iri, quotePost.quoteAuthorizationIri));
    if (quotePost.actor.accountId == null) {
      const activity = new vocab.Delete({
        id: new URL("#delete", quotePost.quoteAuthorizationIri),
        actor: fedCtx.getActorUri(account.id),
        object: new URL(quotePost.quoteAuthorizationIri),
      });
      await fedCtx.sendActivity(
        { identifier: account.id },
        toRecipient(quotePost.actor),
        activity,
        {
          orderingKey: quotePost.quoteAuthorizationIri,
          excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
        },
      );
    } else if (updatedQuote != null) {
      await sendLocalQuoteAuthorizationDelete(
        fedCtx,
        account,
        updatedQuote,
        quotePost.quoteAuthorizationIri,
      );
    }
  }
  await updateQuotesCount(db, quotedPost, -1);
  // The quoted post lost a public quote, so re-score its link.
  await refreshNewsScores(db, [quotedPost.linkId]);
  return updatedPost;
}

async function sendLocalQuoteAuthorizationDelete(
  fedCtx: Context<ContextData>,
  account: Account,
  quote: QuoteUpdatePost,
  quoteAuthorizationIri: string,
): Promise<void> {
  const activity = new vocab.Delete({
    id: new URL("#delete", quoteAuthorizationIri),
    actor: fedCtx.getActorUri(account.id),
    object: new URL(quoteAuthorizationIri),
  });
  const excludeBaseUris = [
    new URL(fedCtx.origin),
    new URL(fedCtx.canonicalOrigin),
  ];
  if (quote.mentions.length > 0) {
    await fedCtx.sendActivity(
      { identifier: account.id },
      quote.mentions.map((mention) => toRecipient(mention.actor)),
      activity,
      {
        orderingKey: quoteAuthorizationIri,
        preferSharedInbox: false,
        excludeBaseUris,
      },
    );
  }
  if (
    quote.visibility !== "public" &&
    quote.visibility !== "unlisted" &&
    quote.visibility !== "followers"
  ) {
    return;
  }
  const followers = await fedCtx.data.db.query.followingTable.findMany({
    with: { follower: true },
    where: {
      followeeId: quote.actorId,
      accepted: { isNotNull: true },
    },
  });
  if (followers.length < 1) return;
  await fedCtx.sendActivity(
    { identifier: account.id },
    followers.map((following) => toRecipient(following.follower)),
    activity,
    {
      orderingKey: quoteAuthorizationIri,
      preferSharedInbox: true,
      excludeBaseUris,
    },
  );
}

async function sendLocalQuoteUpdate(
  fedCtx: Context<ContextData>,
  quote: QuoteUpdatePost,
  quoteAuthorizationIri: string | null,
  updated: Date,
): Promise<void> {
  if (quote.actor.accountId == null || quote.noteSourceId == null) return;
  const noteSource = await fedCtx.data.db.query.noteSourceTable.findFirst({
    where: { id: quote.noteSourceId },
    with: {
      account: true,
      media: { with: { medium: true }, orderBy: { index: "asc" } },
    },
  });
  if (noteSource == null) return;
  const noteObject = await getNote(fedCtx, noteSource, {
    replyTargetId: quote.replyTarget == null
      ? undefined
      : new URL(quote.replyTarget.iri),
    quotedPost: quote.quotedPost ?? undefined,
    quoteAuthorizationIri,
  });
  const update = new vocab.Update({
    id: new URL(
      `#update/${updated.toISOString()}`,
      noteObject.id ?? fedCtx.canonicalOrigin,
    ),
    actor: fedCtx.getActorUri(quote.actor.accountId),
    tos: noteObject.toIds,
    ccs: noteObject.ccIds,
    object: noteObject,
  });
  const excludeBaseUris = [
    new URL(fedCtx.origin),
    new URL(fedCtx.canonicalOrigin),
  ];
  if (quote.mentions.length > 0) {
    await fedCtx.sendActivity(
      { identifier: quote.actor.accountId },
      quote.mentions.map((mention) => toRecipient(mention.actor)),
      update,
      {
        orderingKey: quote.iri,
        preferSharedInbox: false,
        excludeBaseUris,
      },
    );
  }
  if (
    quote.visibility === "public" ||
    quote.visibility === "unlisted" ||
    quote.visibility === "followers"
  ) {
    await fedCtx.sendActivity(
      { identifier: quote.actor.accountId },
      "followers",
      update,
      {
        orderingKey: quote.iri,
        preferSharedInbox: true,
        excludeBaseUris,
      },
    );
  }
  const relayedTags = await sendTagsPubRelayActivity(
    fedCtx,
    quote.actor.accountId,
    update,
    {
      orderingKey: quote.iri,
      visibility: quote.visibility,
      accountBio: noteSource.account.bio,
      relayedTags: quote.relayedTags,
    },
  );
  if (relayedTags != null) {
    await fedCtx.data.db.update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, quote.id));
    quote.relayedTags = [...relayedTags];
  }
}

export async function deletePost(
  fedCtx: Context<ContextData>,
  post: Post & { actor: Actor; replyTarget: Post | null },
): Promise<void> {
  const { db } = fedCtx.data;
  const replies = await db.query.postTable.findMany({
    with: { actor: true },
    where: {
      replyTargetId: post.id,
      OR: [
        { articleSourceId: { isNotNull: true } },
        { noteSourceId: { isNotNull: true } },
      ],
    },
  });
  for (const reply of replies) {
    await deletePost(fedCtx, { ...reply, replyTarget: post });
  }
  // Get posts quoting this post before deleting
  const quotingPosts = await db.query.postTable.findMany({
    where: {
      quotedPostId: post.id,
    },
  });

  const interactions = await db.delete(postTable).where(
    or(
      eq(postTable.replyTargetId, post.id),
      eq(postTable.sharedPostId, post.id),
      eq(postTable.quotedPostId, post.id),
      eq(postTable.id, post.id),
    ),
  ).returning();

  const originalPostIds = [
    post.replyTargetId,
    post.sharedPostId,
    post.quotedPostId,
  ].filter((id): id is Uuid => id != null);
  const originalPosts = originalPostIds.length < 1
    ? []
    : await db.query.postTable.findMany({
      where: {
        OR: originalPostIds.map((id) => ({ id })),
      },
    });

  if (post.replyTargetId != null) {
    const replyTarget = originalPosts.find((p) => p.id === post.replyTargetId);
    if (replyTarget != null) {
      await updateRepliesCount(db, replyTarget, -1);
    }
  }
  if (post.sharedPostId != null) {
    const sharedPost = originalPosts.find((p) => p.id === post.sharedPostId);
    if (sharedPost != null) {
      await updateSharesCount(db, sharedPost, -1);
    }
  }
  if (post.quotedPostId != null) {
    const quotedPost = originalPosts.find((p) => p.id === post.quotedPostId);
    if (quotedPost != null) {
      await updateQuotesCount(db, quotedPost, -1);
    }
  }

  // When a quoted post is deleted, update the quotes count of the original posts
  for (const quotingPost of quotingPosts) {
    if (quotingPost.quotedPostId) {
      const quotedPost = await db.query.postTable.findFirst({
        where: {
          id: quotingPost.quotedPostId,
        },
      });
      if (quotedPost) {
        await updateQuotesCount(db, quotedPost, -1);
      }
    }
  }
  // Re-score every link affected by this cascade: the link each deleted post
  // shared (this post plus its bulk-deleted replies/quotes/boosts, any of which
  // may itself be a sharing post), and the links of the posts this post replied
  // to / quoted (whose public reply/quote count dropped).
  const affectedLinkIds = new Set<Uuid>();
  const parentIds = new Set<Uuid>();
  for (const deleted of interactions) {
    if (deleted.linkId != null) affectedLinkIds.add(deleted.linkId);
    // A bulk-deleted interaction may reply to or quote a story other than this
    // post (e.g. a post that quoted this one while also replying to a different
    // story); that story's public reply/quote count just dropped too.
    if (deleted.replyTargetId != null) parentIds.add(deleted.replyTargetId);
    if (deleted.quotedPostId != null) parentIds.add(deleted.quotedPostId);
  }
  for (const original of originalPosts) {
    if (original.linkId != null) affectedLinkIds.add(original.linkId);
  }
  if (parentIds.size > 0) {
    const parents = await db.query.postTable.findMany({
      where: { id: { in: [...parentIds] } },
      columns: { linkId: true },
    });
    for (const parent of parents) {
      if (parent.linkId != null) affectedLinkIds.add(parent.linkId);
    }
  }
  await refreshNewsScores(db, [...affectedLinkIds]);
  const noteSourceIds = interactions
    .filter((i) => i.noteSourceId != null)
    .map((i) => i.noteSourceId!);
  if (noteSourceIds.length > 0) {
    await db.delete(noteSourceTable).where(
      inArray(noteSourceTable.id, noteSourceIds),
    );
  }
  const articleSourceIds = interactions
    .filter((i) => i.articleSourceId != null)
    .map((i) => i.articleSourceId!);
  if (articleSourceIds.length > 0) {
    await db.delete(articleSourceTable).where(
      inArray(articleSourceTable.id, articleSourceIds),
    );
  }
  if (post.actor.accountId == null) return;
  const interactors = await db.query.actorTable.findMany({
    where: {
      id: { in: [...interactions, ...originalPosts].map((i) => i.actorId) },
    },
  });
  const recipients: Recipient[] = interactors.map((actor) => ({
    id: new URL(actor.iri),
    inboxId: new URL(actor.inboxUrl),
    endpoints: actor.sharedInboxUrl == null ? null : {
      sharedInbox: new URL(actor.sharedInboxUrl),
    },
  }));
  const activity = new vocab.Delete({
    id: new URL("#delete", post.iri),
    actor: fedCtx.getActorUri(post.actor.accountId),
    to: PUBLIC_COLLECTION,
    cc: fedCtx.getFollowersUri(post.actor.accountId),
    object: new vocab.Tombstone({
      id: new URL(post.iri),
    }),
  });
  await fedCtx.sendActivity(
    { identifier: post.actor.accountId },
    "followers",
    activity,
    {
      orderingKey: post.iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  await sendTagsPubRelayActivity(fedCtx, post.actor.accountId, activity, {
    orderingKey: post.iri,
    visibility: post.visibility,
    accountBio: post.actor.bioHtml,
    relayedTags: post.relayedTags,
  });
  await fedCtx.sendActivity(
    { identifier: post.actor.accountId },
    recipients,
    activity,
    {
      orderingKey: post.iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
}

export async function scrapePostLink<TContextData>(
  fedCtx: Context<TContextData>,
  url: string | URL,
  handleToActorId: (handle: string) => Promise<Uuid | undefined>,
  options: { signal?: AbortSignal } = {},
): Promise<NewPostLink | undefined> {
  const lg = logger.getChild("scrapePostLink");
  url = typeof url === "string" ? new URL(url) : url;
  if (!isSSRFSafeURL(url.href)) {
    lg.error("Unsafe URL: {url}", { url: url.href });
    return undefined;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": getUserAgent({
          software: "HackersPub",
          url: new URL(fedCtx.canonicalOrigin),
        }),
      },
      redirect: "follow",
      signal: getRemoteFetchSignal(options.signal),
    });
  } catch (error) {
    // Best-effort link-preview scrape: a remote being unreachable (DNS, TLS,
    // connection errors) is expected and not actionable, so log at `warn` to
    // keep it out of error tracking. The post still persists without a preview.
    lg.warn("Failed to fetch {url}: {error}", { url: url.href, error });
    return undefined;
  }
  const responseUrl = response.url == null || response.url === ""
    ? url.href
    : response.url;
  if (!response.ok) {
    // Best-effort: many sites refuse scrapers (403) or are briefly down (5xx).
    // Not actionable, so `warn` rather than `error`.
    lg.warn("Failed to scrape {url}: {status} {statusText}", {
      url: responseUrl,
      status: response.status,
      statusText: response.statusText,
    });
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const fullContentType = response.headers.get("Content-Type");
  const contentType = fullContentType?.replace(/\s*;.*$/, "");
  if (
    contentType === "application/pdf" || contentType === "application/x-pdf"
  ) {
    try {
      const pdf = await PDFDocument.load(await response.bytes(), {
        updateMetadata: false,
      });
      return {
        id: generateUuidV7(),
        url: responseUrl,
        title: pdf.getTitle(),
        description: pdf.getSubject(),
        author: pdf.getAuthor(),
      };
    } catch (error) {
      lg.warn("Failed to read or parse PDF from {url}: {error}", {
        url: responseUrl,
        error,
      });
      return undefined;
    }
  }
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    lg.warn("Not an HTML page: {url} ({contentType})", {
      url: responseUrl,
      contentType,
    });
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const contentTypeParams = Object.fromEntries(
    (fullContentType
      ?.replace(/^[^;]*;\s*/, "")
      ?.split(/\s*;\s*/g) ?? []).map((pair: string) => pair.split(/\s*=\s*/))
      .filter((pair) => pair.length === 2).map((pair) =>
        pair as [string, string]
      ),
  );
  let charset = contentTypeParams.charset?.toLowerCase();
  let bytes: Uint8Array;
  try {
    bytes = await response.bytes();
  } catch (error) {
    lg.warn("Failed to read body from {url}: {error}", {
      url: responseUrl,
      error,
    });
    return undefined;
  }
  if (!charset) {
    // Try to find charset in meta tags if not specified in Content-Type
    const decoder = new TextDecoder();
    const rawHtml = decoder.decode(bytes);
    const charsetMatch = rawHtml.match(/<meta\s+.*?charset=["']?([\w-]+)/i);
    if (charsetMatch != null) charset = charsetMatch[1].toLowerCase();
  }

  const html = !charset || charset === "utf-8" || charset === "utf8"
    ? new TextDecoder().decode(bytes)
    : iconv.decode(Buffer.from(bytes), charset);
  if (html.trim().length < 1) {
    lg.warn("Empty HTML page: {url}", { url: responseUrl });
    return undefined;
  }
  let result: Awaited<ReturnType<typeof ogs>>["result"];
  try {
    const scraped = await ogs({
      html,
      customMetaTags: [
        {
          multiple: false,
          property: "fediverse:creator",
          fieldName: "fediverseCreator",
        },
      ],
    });
    if (scraped.error) {
      // Best-effort: the page loaded but Open Graph parsing failed. Not
      // actionable, so `warn` rather than `error`.
      lg.warn("Failed to scrape {url}: {error}", {
        url: responseUrl,
        result: scraped.result,
      });
      return undefined;
    }
    result = scraped.result;
  } catch (error) {
    // `open-graph-scraper` throws plain objects for parser setup failures.
    // Link previews are best-effort, so do not fail ActivityPub ingestion.
    lg.warn("Failed to scrape {url}: {error}", { url: responseUrl, error });
    return undefined;
  }
  lg.debug("Scraped {url}: {result}", { url: responseUrl, result });
  const ogImage = result.ogImage ?? [];
  const twitterImage = result.twitterImage ?? [];
  const image = ogImage.length > 0
    ? {
      imageUrl: new URL(ogImage[0].url, responseUrl).href,
      imageAlt: ogImage[0].alt,
      imageType: ogImage[0].type === "png"
        ? "image/png"
        : ogImage[0].type === "jpg" || ogImage[0].type === "jpeg"
        ? "image/jpeg"
        : ogImage[0].type == null ||
            !ogImage[0].type.startsWith("image/")
        ? undefined
        : ogImage[0].type,
      imageWidth: typeof ogImage[0].width === "string"
        ? parseInt(ogImage[0].width)
        : ogImage[0].width,
      imageHeight: typeof ogImage[0].height === "string"
        ? parseInt(ogImage[0].height)
        : ogImage[0].height,
    }
    : twitterImage.length > 0
    ? {
      imageUrl: new URL(twitterImage[0].url, responseUrl).href,
      imageAlt: twitterImage[0].alt,
      imageWidth: typeof twitterImage[0].width === "string"
        ? parseInt(twitterImage[0].width)
        : twitterImage[0].width,
      imageHeight: typeof twitterImage[0].height === "string"
        ? parseInt(twitterImage[0].height)
        : twitterImage[0].height,
    }
    : {};
  if (
    image.imageUrl != null &&
    (image.imageWidth == null || image.imageHeight == null)
  ) {
    try {
      const response = await fetch(image.imageUrl, {
        headers: {
          "User-Agent": getUserAgent({
            software: "HackersPub",
            url: new URL(fedCtx.canonicalOrigin),
          }),
          "Accept": "image/*",
          "Range": `bytes=0-${SCRAPE_IMAGE_METADATA_BYTES_LIMIT - 1}`,
          "Referer": responseUrl,
        },
        redirect: "follow",
        signal: getRemoteFetchSignal(options.signal),
      });
      logger.debug("Fetched image {url}: {status} {statusText}", {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
      });
      if (response.ok) {
        const body = await readResponseBytesAtMost(
          response,
          SCRAPE_IMAGE_METADATA_BYTES_LIMIT,
        );
        try {
          const metadata = await sharp(body).metadata();
          switch (metadata.orientation) {
            case 6:
            case 8:
              image.imageWidth = metadata.height;
              image.imageHeight = metadata.width;
              break;
            case 1:
            case 3:
            default:
              image.imageWidth = metadata.width;
              image.imageHeight = metadata.height;
              break;
          }
        } catch {
          image.imageWidth = undefined;
          image.imageHeight = undefined;
        }
      }
    } catch (error) {
      logger.debug(
        "Failed to fetch image {url}: {error}",
        { url: image.imageUrl, error },
      );
      image.imageWidth = undefined;
      image.imageHeight = undefined;
    }
  }
  const creatorHandle = result.customMetaTags?.fediverseCreator == null
    ? undefined
    : Array.isArray(result.customMetaTags.fediverseCreator)
    ? result.customMetaTags.fediverseCreator[0]
    : result.customMetaTags.fediverseCreator;
  const canonicalUrl = new URL(
    result.ogUrl ?? result.twitterUrl ?? result.requestUrl ??
      responseUrl,
    responseUrl,
  );
  // Verify if the canonical URL they claim is the same as the one we
  // requested.
  const canonicalUrlVerified = canonicalUrl.origin === url.origin ||
    new URL(responseUrl ?? url).origin;
  return {
    id: generateUuidV7(),
    url: canonicalUrlVerified ? canonicalUrl.href : responseUrl,
    title: result.ogTitle ?? result.twitterTitle,
    siteName: result.ogSiteName,
    type: result.ogType,
    description: result.ogDescription ?? result.twitterDescription,
    author: result.ogArticleAuthor,
    creatorId: creatorHandle == null || handleToActorId == null
      ? undefined
      : await handleToActorId(creatorHandle),
    ...image,
  };
}

const POST_LINK_CACHE_TTL = Temporal.Duration.from({ hours: 24 });

export async function persistPostLink(
  ctx: Context<ContextData>,
  url: string | URL,
  options: { signal?: AbortSignal } = {},
): Promise<PostLink | undefined> {
  if (typeof url === "string") url = new URL(url);
  if (!isSSRFSafeURL(url.href)) {
    logger.error("Unsafe URL: {url}", { url: url.href });
    return undefined;
  }
  const { db } = ctx.data;
  const link = await db.query.postLinkTable.findFirst({
    where: { url: url.href },
  });
  if (link != null) {
    const scraped = link.scraped.toTemporalInstant();
    if (
      Temporal.Instant.compare(
        scraped.add(POST_LINK_CACHE_TTL),
        Temporal.Now.instant(),
      ) > 0
    ) {
      logger.debug("Post link cache hit: {url}", { url: url.href });
      return link;
    }
  }
  let scrapedLink = await scrapePostLink(ctx, url, async (handle) => {
    if (!handle.startsWith("@")) handle = `@${handle}`;
    const actors = await persistActorsByHandles(ctx, [handle]);
    return actors[handle]?.id;
  }, {
    signal: options.signal,
  });
  logger.debug("Scraped link {url}: {link}", {
    url: url.href,
    link: scrapedLink,
  });
  if (scrapedLink == null) return undefined;
  if (scrapedLink.imageWidth == null || scrapedLink.imageHeight == null) {
    scrapedLink = {
      ...scrapedLink,
      imageWidth: undefined,
      imageHeight: undefined,
    };
  }
  const result = await db
    .insert(postLinkTable)
    .values(scrapedLink)
    .onConflictDoUpdate({
      target: postLinkTable.url,
      set: {
        title: scrapedLink.title,
        siteName: scrapedLink.siteName,
        type: scrapedLink.type,
        description: scrapedLink.description,
        imageUrl: scrapedLink.imageUrl,
        imageAlt: scrapedLink.imageAlt,
        imageType: scrapedLink.imageType,
        imageWidth: scrapedLink.imageWidth,
        imageHeight: scrapedLink.imageHeight,
        creatorId: scrapedLink.creatorId,
        scraped: sql`CURRENT_TIMESTAMP`,
      },
      setWhere: eq(postLinkTable.url, scrapedLink.url),
    })
    .returning();
  return result[0];
}
