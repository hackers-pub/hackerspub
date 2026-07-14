export {
  PERSIST_POST_OVERALL_BUDGET_MS,
  REMOTE_FETCH_TIMEOUT_MS,
  withDocumentLoaderTimeout,
} from "./remote-fetch.ts";
import type { DocumentLoader } from "@fedify/fedify";
import {
  isActor,
  LanguageString,
  lookupObject,
  PUBLIC_COLLECTION,
  traverseCollection,
} from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { assertNever } from "@std/assert/unstable-never";
import {
  and,
  arrayOverlaps,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import {
  getPersistedActor,
  isFederationBlocked,
  persistActor,
} from "../actor.ts";
import type { ApplicationContext } from "../context.ts";
import { toDate } from "../date.ts";
import { type Database, runInTransaction } from "../db.ts";
import { extractExternalLinks } from "../html.ts";
import { persistPostMedium } from "../medium.ts";
import { refreshNewsScores, refreshNewsScoresForPostLinks } from "../news.ts";
import { persistPoll } from "../poll.ts";
import {
  type Actor,
  actorTable,
  type Instance,
  type Mention,
  mentionTable,
  type NewPost,
  type Poll,
  type Post,
  postMediumTable,
  postTable,
  type PostVisibility,
  quoteAuthorizationTable,
  quoteRequestTable,
} from "../schema.ts";
import { queueAfterCommit } from "../tx.ts";
import { generateUuidV7, type Uuid } from "../uuid.ts";

import { persistPostLink } from "../link-preview.ts";
import { getPersistedPost, isPostObject, type PostObject } from "./core.ts";
import {
  createTargetPostUpdatedNotifications,
  persistArticleNewsLink,
} from "./persistence.ts";
import {
  PERSIST_POST_OVERALL_BUDGET_MS,
  REMOTE_FETCH_TIMEOUT_MS,
  withDocumentLoaderTimeout,
} from "./remote-fetch.ts";
import {
  updateQuotesCount,
  updateRepliesCount,
  updateSharesCount,
} from "./engagement.ts";
import {
  canActorQuotePost,
  getOriginalPostId,
  quotePoliciesFromInteractionPolicy,
} from "./visibility.ts";

const logger = getLogger(["hackerspub", "models", "post", "remote"]);
const DEFAULT_MAX_PERSIST_POST_DEPTH = 3;
const DEFAULT_MAX_INLINE_REPLIES = 50;
const DEFAULT_INLINE_REPLIES_THRESHOLD = 10;
const REPLIES_BACKFILL_LOCK_TTL_MS = 300_000;
const REPLIES_BACKFILL_RETRY_DELAY_MS = 30_000;
const EMOJI_REACTIONS_BACKFILL_LOCK_TTL_MS = 300_000;
const EMOJI_REACTIONS_BACKFILL_RETRY_DELAY_MS = 30_000;
const MAX_EMOJI_REACTIONS_BACKFILL = 500;
const INLINE_REPLIES_TRAVERSAL_BUDGET_MS = 15_000;
const disabledDocumentLoader: DocumentLoader = (url) =>
  Promise.reject(new TypeError(`Remote fetch disabled for ${url}`));

async function backfillEmojiReactions(
  ctx: ApplicationContext,
  post: PostObject,
  persistedPost: Pick<Post, "id" | "iri">,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  },
): Promise<void> {
  const opts = {
    contextLoader: options.contextLoader,
    documentLoader: withDocumentLoaderTimeout(
      options.documentLoader ?? ctx.documentLoader,
    ),
    suppressError: true,
  };
  const collection = await post.getEmojiReactions(opts);
  if (collection == null) return;
  const { persistReaction, updateReactionsCounts } = await import(
    "../reaction.ts"
  );
  let shouldUpdateCounts = false;
  try {
    let scanned = 0;
    for await (const item of traverseCollection(collection, opts)) {
      if (scanned >= MAX_EMOJI_REACTIONS_BACKFILL) break;
      scanned++;
      if (!(item instanceof vocab.Like || item instanceof vocab.EmojiReact)) {
        continue;
      }
      if (item.objectId?.href !== persistedPost.iri) continue;
      shouldUpdateCounts = true;
      await persistReaction(ctx, item, opts);
    }
  } finally {
    if (shouldUpdateCounts) {
      await updateReactionsCounts(ctx.db, persistedPost.id);
    }
  }
}

async function enqueueEmojiReactionsBackfill(
  ctx: ApplicationContext,
  post: PostObject,
  persistedPost: Pick<Post, "id" | "iri">,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  },
): Promise<void> {
  const lockKey = `emoji-reactions-backfill/${persistedPost.iri}`;
  const [locked] = await ctx.kv.getMany<string>([lockKey]);
  if (locked === "1") return;
  await ctx.kv.set(
    lockKey,
    "1",
    EMOJI_REACTIONS_BACKFILL_LOCK_TTL_MS,
  );
  void (async () => {
    const run = async (attempt: number): Promise<void> => {
      try {
        await backfillEmojiReactions(ctx, post, persistedPost, options);
      } catch (error) {
        if (attempt < 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, EMOJI_REACTIONS_BACKFILL_RETRY_DELAY_MS)
          );
          await run(attempt + 1);
          return;
        }
        logger.warn(
          "Failed to backfill emoji reactions for {postIri} after retry: " +
            "{error}",
          { postIri: persistedPost.iri, error },
        );
      }
    };
    await run(0);
  })().catch((error) => {
    logger.warn(
      "Emoji reactions backfill task failed for {postIri}: {error}",
      { postIri: persistedPost.iri, error },
    );
  });
}

type PersistedQuoteTarget = Post & { actor: Actor & { instance: Instance } };

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

async function resolveMentionedActors(
  ctx: ApplicationContext,
  mentionHrefs: ReadonlySet<string>,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  },
  fetchRemote = true,
): Promise<Actor[]> {
  if (mentionHrefs.size < 1) return [];
  const { db } = ctx;
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
  if (!fetchRemote) return [...actorsById.values()];
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

export async function persistPost(
  ctx: ApplicationContext,
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
     * Whether linked ActivityPub objects and external resources may be
     * fetched while persisting the post.  Set this to `false` only when the
     * caller already dereferenced the post and must keep the remaining work
     * database-only, such as inside an inbox transaction.
     */
    fetchRemote?: boolean;
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
  const { db } = ctx;
  const depth = options.depth ?? 0;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_PERSIST_POST_DEPTH;
  const maxReplies = options.maxReplies ?? DEFAULT_MAX_INLINE_REPLIES;
  const inlineRepliesThreshold = options.inlineRepliesThreshold ??
    DEFAULT_INLINE_REPLIES_THRESHOLD;
  const deferLargeReplies = options.deferLargeReplies ?? true;
  const fetchRemote = options.fetchRemote ?? true;
  const shouldRecurse = fetchRemote && depth < maxDepth;
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
    contextLoader: fetchRemote ? options.contextLoader : disabledDocumentLoader,
    documentLoader: fetchRemote
      ? withDocumentLoaderTimeout(
        options.documentLoader ?? ctx.documentLoader,
        REMOTE_FETCH_TIMEOUT_MS,
        overallSignal,
      )
      : disabledDocumentLoader,
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
  const mentionedActors = await resolveMentionedActors(
    ctx,
    mentions,
    opts,
    fetchRemote,
  );
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
  const qualifyingArticleNewsPost = fetchRemote && type === "Article" &&
    (visibility === "public" || visibility === "unlisted") &&
    replyTarget == null &&
    quotedPost == null;
  const articleNewsLink = qualifyingArticleNewsPost
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
  const embeddedLink = fetchRemote && articleNewsLink == null &&
      externalLinks.length > 0
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
    // Keep the exact URL from the post body for navigation.  Canonical
    // metadata and redirects belong to the shared PostLink identity only.
    linkUrl: link == null
      ? null
      : articleNewsLink != null
      ? articleNewsLink.url
      : externalLinks[0].href,
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
    ...fullUpdateSet
  } = values;
  const updateSet = fetchRemote ? fullUpdateSet : {
    type: values.type,
    visibility: values.visibility,
    quotePolicy: values.quotePolicy,
    quoteRequestPolicy: values.quoteRequestPolicy,
    actorId: values.actorId,
    sensitive: values.sensitive,
    name: values.name,
    summary: values.summary,
    contentHtml: values.contentHtml,
    language: values.language,
    url: values.url,
    updated: values.updated,
    published: values.published,
  };
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
  if (fetchRemote) {
    await db.delete(mentionTable).where(
      eq(mentionTable.postId, persistedPost.id),
    );
  }

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
  if (fetchRemote) {
    await db.delete(postMediumTable).where(
      eq(postMediumTable.postId, persistedPost.id),
    );
  }
  let i = 0;
  if (fetchRemote) {
    for (const attachment of attachments) {
      await persistPostMedium(ctx, attachment, persistedPost.id, i);
      i++;
    }
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
      try {
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
      } finally {
        await repliesIterator.return?.();
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
      const [locked] = await ctx.kv.getMany<string>([lockKey]);
      if (locked !== "1") {
        // Best-effort dedupe lock: avoid spawning multiple backfills for
        // the same post during bursty inbox traffic.
        await ctx.kv.set(lockKey, "1", REPLIES_BACKFILL_LOCK_TTL_MS);
        await queueAfterCommit(ctx, () => {
          const backgroundDb = ctx.rootDb ?? ctx.db;
          const backgroundCtx: ApplicationContext = {
            ...ctx.withDatabase(backgroundDb),
            db: backgroundDb,
            rootDb: backgroundDb,
            afterCommit: undefined,
          };
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
                options.documentLoader ?? backgroundCtx.documentLoader,
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
                  await persistPost(backgroundCtx, reply, {
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
                  await backgroundDb.update(postTable)
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
            logger.warn(
              "Replies backfill task failed for {postIri}: {error}",
              {
                postIri: persistedPost.iri,
                error,
              },
            );
          });
        });
      }
    }
  }
  let poll: Poll | undefined;
  if (post instanceof vocab.Question) {
    poll = await persistPoll(db, post, persistedPost.id);
  }
  if (depth === 0 && fetchRemote) {
    await queueAfterCommit(ctx, () => {
      const db = ctx.rootDb ?? ctx.db;
      return enqueueEmojiReactionsBackfill(
        {
          ...ctx.withDatabase(db),
          db,
          rootDb: db,
          afterCommit: undefined,
        },
        post,
        persistedPost,
        {
          contextLoader: options.contextLoader,
          documentLoader: options.documentLoader,
        },
      );
    });
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
  ctx: ApplicationContext,
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
  const announceId = announce.id.href;
  const { db } = ctx;
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
    iri: announceId,
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
  return await runInTransaction(db, async (tx) => {
    const lockKeys = [
      `announce:${announceId}`,
      `share:${actor.id}:${post.id}`,
    ].sort();
    for (const lockKey of lockKeys) {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
      `);
    }

    const existingByIri = await tx.query.postTable.findFirst({
      where: { iri: announceId },
    });
    if (existingByIri != null && existingByIri.sharedPostId == null) {
      logger.warn(
        "Dropping Announce {announceId}: its IRI belongs to a non-share post.",
        { announceId },
      );
      return undefined;
    }
    const existingByPair = await tx.query.postTable.findFirst({
      where: { actorId: actor.id, sharedPostId: post.id },
    });
    const affectedNewsLinkIds = new Set<Uuid>();
    if (post.type === "Article" && post.linkId != null) {
      affectedNewsLinkIds.add(post.linkId);
    }

    if (
      existingByIri != null && existingByPair != null &&
      existingByIri.id !== existingByPair.id
    ) {
      logger.warn(
        "Keeping existing share {shareId}: Announce {announceId} also belongs to share {iriShareId}.",
        {
          shareId: existingByPair.id,
          announceId,
          iriShareId: existingByIri.id,
        },
      );
      await refreshNewsScores(tx, [...affectedNewsLinkIds]);
      return { ...existingByPair, actor, sharedPost: post };
    }
    const existing = existingByIri ?? existingByPair;

    let persistedShare: Post;
    if (existing == null) {
      const rows = await tx.insert(postTable)
        .values({ id: generateUuidV7(), ...values })
        .returning();
      if (rows.length < 1) return undefined;
      persistedShare = rows[0];
      await updateSharesCount(tx, post, 1);
    } else {
      const rows = await tx.update(postTable)
        .set(values)
        .where(eq(postTable.id, existing.id))
        .returning();
      if (rows.length < 1) return undefined;
      persistedShare = rows[0];
      if (existing.sharedPostId !== post.id) {
        if (existing.sharedPostId != null) {
          const previousPost = await tx.query.postTable.findFirst({
            where: { id: existing.sharedPostId },
          });
          if (previousPost != null) {
            await updateSharesCount(tx, previousPost, -1);
            if (
              previousPost.type === "Article" && previousPost.linkId != null
            ) {
              affectedNewsLinkIds.add(previousPost.linkId);
            }
          }
        }
        await updateSharesCount(tx, post, 1);
      }
    }

    await refreshNewsScores(tx, [...affectedNewsLinkIds]);
    return { ...persistedShare, actor, sharedPost: post };
  });
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
