import {
  type Context,
  type DocumentLoader,
  getUserAgent,
  isActor,
  LanguageString,
  lookupObject,
  PUBLIC_COLLECTION,
  type Recipient,
  traverseCollection,
} from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getAnnounce } from "@hackerspub/federation/objects";
import { getLogger } from "@logtape/logtape";
import { assertNever } from "@std/assert/unstable-never";
import {
  and,
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
import postgres from "postgres";
import sharp from "sharp";
import { isSSRFSafeURL } from "ssrfcheck";
import {
  getPersistedActor,
  persistActor,
  persistActorsByHandles,
  syncActorFromAccount,
  toRecipient,
} from "./actor.ts";
import { getOriginalArticleContent } from "./article.ts";
import type { ContextData } from "./context.ts";
import { toDate } from "./date.ts";
import type { Database, RelationsFilter } from "./db.ts";
import { extractExternalLinks } from "./html.ts";
import { renderMarkup } from "./markup.ts";
import { persistPostMedium } from "./medium.ts";
import {
  createShareNotification,
  deleteShareNotification,
} from "./notification.ts";
import { persistPoll } from "./poll.ts";
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
  type Mention,
  mentionTable,
  type NewPost,
  type NewPostLink,
  type NoteMedium,
  type NoteSource,
  noteSourceTable,
  type Poll,
  type Post,
  type PostLink,
  postLinkTable,
  type PostMedium,
  postMediumTable,
  postTable,
  type PostVisibility,
  type Reaction,
} from "./schema.ts";
import { addPostToTimeline, removeFromTimeline } from "./timeline.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "post"]);

export type PostObject = vocab.Article | vocab.Note | vocab.Question;

export function isPostObject(object: unknown): object is PostObject {
  return object instanceof vocab.Article || object instanceof vocab.Note ||
    object instanceof vocab.Question;
}

export function isArticleLike(
  post: Post & { actor: Actor & { instance: Instance } },
): boolean {
  return post.type === "Article" ||
    post.name != null && post.actor.instance.software !== "nodebb";
}

export async function syncPostFromArticleSource(
  fedCtx: Context<ContextData>,
  articleSource: ArticleSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    contents: ArticleContent[];
  },
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    articleSource: ArticleSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      contents: ArticleContent[];
    };
    mentions: Mention[];
  }
> {
  const { db, kv } = fedCtx.data;
  const actor = await syncActorFromAccount(fedCtx, articleSource.account);
  const content = getOriginalArticleContent(articleSource);
  if (content == null) {
    throw new Error("No content.");
  }
  const rendered = await renderMarkup(fedCtx, content.content, {
    docId: articleSource.id,
    kv,
  });
  const url =
    `${fedCtx.origin}/@${articleSource.account.username}/${articleSource.publishedYear}/${
      encodeURIComponent(articleSource.slug)
    }`;
  const values: Omit<NewPost, "id"> = {
    iri: fedCtx.getObjectUri(vocab.Article, { id: articleSource.id }).href,
    type: "Article",
    visibility: "public",
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
    url,
    updated: articleSource.updated,
    published: articleSource.published,
  };
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.articleSourceId,
      set: values,
      setWhere: eq(postTable.articleSourceId, articleSource.id),
    })
    .returning();
  const [post] = rows;
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
  return { ...post, actor, mentions, articleSource };
}

export async function syncPostFromNoteSource(
  fedCtx: Context<ContextData>,
  noteSource: NoteSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    media: NoteMedium[];
  },
  relations: {
    replyTarget?: Post & { actor: Actor };
    quotedPost?: Post & { actor: Actor };
  } = {},
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      media: NoteMedium[];
    };
    replyTarget: Post & { actor: Actor } | null;
    quotedPost: Post & { actor: Actor } | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
  }
> {
  const { db, kv, disk } = fedCtx.data;
  const actor = await syncActorFromAccount(fedCtx, noteSource.account);
  // FIXME: Note should be rendered in a different way
  const rendered = await renderMarkup(fedCtx, noteSource.content, {
    docId: noteSource.id,
    kv,
  });
  const externalLinks = extractExternalLinks(rendered.html);
  const link = externalLinks.length > 0
    ? await persistPostLink(fedCtx, externalLinks[0])
    : undefined;
  const url =
    `${fedCtx.canonicalOrigin}/@${noteSource.account.username}/${noteSource.id}`;
  const values: Omit<NewPost, "id"> = {
    iri: fedCtx.getObjectUri(vocab.Note, { id: noteSource.id }).href,
    type: "Note",
    visibility: noteSource.visibility,
    actorId: actor.id,
    noteSourceId: noteSource.id,
    replyTargetId: relations.replyTarget?.id,
    quotedPostId: relations.quotedPost?.sharedPostId ??
      relations.quotedPost?.id,
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
    linkId: link?.id,
    linkUrl: link == null
      ? undefined
      : externalLinks[0].hash === ""
      ? link.url
      : new URL(externalLinks[0].hash, link.url).href,
    url,
    updated: noteSource.updated,
    published: noteSource.published,
  };
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.noteSourceId,
      set: values,
      setWhere: eq(postTable.noteSourceId, noteSource.id),
    })
    .returning();
  const post = rows[0];
  await db.delete(mentionTable).where(eq(mentionTable.postId, post.id));
  const mentionList = globalThis.Object.values(rendered.mentions);

  // Update quotes count if this is a quote post
  if (relations.quotedPost) {
    await updateQuotesCount(db, relations.quotedPost, 1);
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
        type: "image/webp" as const,
        url: await disk.getUrl(medium.key),
        alt: medium.alt,
        width: medium.width,
        height: medium.height,
      }))),
    ).returning()
    : [];
  return {
    ...post,
    actor,
    noteSource,
    mentions,
    media,
    replyTarget: relations.replyTarget ?? null,
    quotedPost: relations.quotedPost ?? null,
  };
}

export async function persistPost(
  ctx: Context<ContextData>,
  post: PostObject,
  options: {
    actor?: Actor & { instance: Instance };
    replyTarget?: Post & { actor: Actor & { instance: Instance } };
    replies?: boolean;
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
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
  if (post.id.origin === ctx.canonicalOrigin) {
    return await getPersistedPost(db, post.id);
  }
  let actor =
    options.actor == null || options.actor.iri !== post.attributionId.href
      ? await getPersistedActor(db, post.attributionId)
      : options.actor;
  const opts = {
    contextLoader: options.contextLoader,
    documentLoader: options.documentLoader,
    suppressError: true,
  };
  if (actor == null) {
    const apActor = await post.getAttribution(opts);
    if (apActor == null) return;
    actor = await persistActor(ctx, apActor, options);
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
  let quotedPost: Post & { actor: Actor & { instance: Instance } } | undefined;
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
    } else {
      for (const iri of quotedPostIris) {
        let obj: vocab.Object | null;
        try {
          obj = await ctx.lookupObject(iri, options);
        } catch {
          continue;
        }
        if (!isPostObject(obj)) continue;
        quotedPost = await persistPost(ctx, obj, {
          replies: false,
          contextLoader: options.contextLoader,
          documentLoader: options.documentLoader,
        });
        if (quotedPost != null) break;
      }
    }
  }
  const attachments: vocab.Document[] = [];
  for await (const attachment of post.getAttachments(opts)) {
    if (attachment instanceof vocab.Document) attachments.push(attachment);
  }
  let replyTarget: Post & { actor: Actor & { instance: Instance } } | undefined;
  if (post.replyTargetId != null) {
    replyTarget = options.replyTarget ??
      await getPersistedPost(db, post.replyTargetId);
    if (replyTarget == null) {
      const apReplyTarget = await post.getReplyTarget(opts);
      if (!isPostObject(apReplyTarget)) return;
      replyTarget = await persistPost(ctx, apReplyTarget, options);
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
  const contentHtml = post.content?.toString();
  let externalLinks = contentHtml == null
    ? []
    : extractExternalLinks(contentHtml);
  if (quotedPost != null) {
    externalLinks = externalLinks.filter((l) =>
      quotedPost.iri !== l.href && quotedPost.url !== l.href
    );
  }
  const link = externalLinks.length > 0
    ? await persistPostLink(ctx, externalLinks[0])
    : undefined;
  const values: Omit<NewPost, "id"> = {
    iri: post.id.href,
    type: post instanceof vocab.Article
      ? "Article"
      : post instanceof vocab.Note
      ? "Note"
      : post instanceof vocab.Question
      ? "Question"
      : assertNever(post, `Unexpected type of post: ${post}`),
    visibility,
    actorId: actor.id,
    sensitive: post.sensitive ?? false,
    name: post.name?.toString(),
    summary: post.summary?.toString(),
    contentHtml,
    language: post.content instanceof LanguageString
      ? post.content.language.compact()
      : post.contents.length > 1 && post.contents[1] instanceof LanguageString
      ? post.contents[1].language.compact()
      : undefined,
    tags,
    emojis,
    linkId: link?.id ?? null,
    linkUrl: link == null
      ? null
      : externalLinks[0].hash === ""
      ? link.url
      : new URL(externalLinks[0].hash, link.url).href,
    url: post.url instanceof vocab.Link ? post.url.href?.href : post.url?.href,
    replyTargetId: replyTarget?.id,
    quotedPostId: quotedPost?.id,
    repliesCount: replies?.totalItems ?? 0,
    sharesCount: shares?.totalItems ?? 0,
    updated: toDate(post.updated ?? post.published) ?? undefined,
    published: toDate(post.published) ?? undefined,
  };
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.iri,
      set: values,
      setWhere: eq(postTable.iri, post.id.href),
    })
    .returning();
  const persistedPost = { ...rows[0], actor };
  await db.delete(mentionTable).where(
    eq(mentionTable.postId, persistedPost.id),
  );

  // Update quotes count if this is a quote post
  if (quotedPost) {
    await updateQuotesCount(db, quotedPost, 1);
  }
  let mentionList: (Mention & { actor: Actor })[] = [];
  if (mentions.size > 0) {
    const mentionedActors = await db.query.actorTable.findMany({
      where: { iri: { in: [...mentions] } },
    });
    for (const mentionedActor of mentionedActors) {
      mentions.delete(mentionedActor.iri);
    }
    if (mentions.size > 0) {
      for (const iri of mentions) {
        const apActor = await lookupObject(iri, options);
        if (!isActor(apActor)) continue;
        const actor = await persistActor(ctx, apActor, options);
        if (actor == null) continue;
        mentionedActors.push(actor);
      }
    }
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
  }
  await db.delete(postMediumTable).where(
    eq(postMediumTable.postId, persistedPost.id),
  );
  let i = 0;
  for (const attachment of attachments) {
    await persistPostMedium(ctx, attachment, persistedPost.id, i);
    i++;
  }
  if (options.replies) {
    if (replies != null) {
      let repliesCount = 0;
      for await (const reply of traverseCollection(replies, opts)) {
        if (!isPostObject(reply)) continue;
        await persistPost(ctx, reply, {
          ...options,
          actor,
          replyTarget: persistedPost,
        });
        repliesCount++;
      }
      if (persistedPost.repliesCount < repliesCount) {
        await db.update(postTable)
          .set({ repliesCount })
          .where(eq(postTable.id, persistedPost.id));
        persistedPost.repliesCount = repliesCount;
      }
    }
  }
  let poll: Poll | undefined;
  if (post instanceof vocab.Question) {
    poll = await persistPoll(db, post, persistedPost.id);
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
  let actor: Actor & { instance: Instance } | undefined =
    options.actor == null || options.actor.iri !== announce.actorId.href
      ? await getPersistedActor(db, announce.actorId)
      : options.actor;
  if (actor == null) {
    const apActor = await announce.getActor(options);
    if (apActor == null) return;
    actor = await persistActor(ctx, apActor, options);
    if (actor == null) return;
  }
  const object = await announce.getObject(options);
  if (!isPostObject(object)) return;
  const post = await persistPost(ctx, object, {
    ...options,
    replies: true,
  });
  if (post == null) return;
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
  let rows: Post[];
  try {
    rows = await db.insert(postTable)
      .values({ id, ...values })
      .onConflictDoUpdate({
        target: postTable.iri,
        set: values,
        setWhere: eq(postTable.iri, announce.id.href),
      })
      .returning();
  } catch (error) {
    if (
      error instanceof postgres.PostgresError &&
      error.constraint_name == "post_actor_id_shared_post_id_unique"
    ) {
      const deleted = await db.delete(postTable)
        .where(
          and(
            eq(postTable.actorId, actor.id),
            eq(postTable.sharedPostId, post.id),
          ),
        );
      await updateSharesCount(db, post, -deleted.length);
      rows = await db.insert(postTable)
        .values({ id, ...values })
        .onConflictDoUpdate({
          target: postTable.iri,
          set: values,
          setWhere: eq(postTable.iri, announce.id.href),
        })
        .returning();
    }
    throw error;
  }
  if (rows.length < 1) return undefined;
  if (rows[0].id === id) await updateSharesCount(db, post, 1);
  return { ...rows[0], actor, sharedPost: post };
}

export async function sharePost(
  fedCtx: Context<ContextData>,
  account: Account & {
    emails: AccountEmail[];
    links: AccountLink[];
  },
  post: Post & { actor: Actor },
): Promise<Post> {
  const { db } = fedCtx.data;
  const actor = await syncActorFromAccount(fedCtx, account);
  const id = generateUuidV7();
  const posts = await db.insert(postTable).values({
    id,
    iri: fedCtx.getObjectUri(vocab.Announce, { id }).href,
    type: post.type,
    visibility: "public",
    actorId: actor.id,
    sharedPostId: post.id,
    name: post.name,
    contentHtml: post.contentHtml,
    language: post.language,
    tags: {},
    emojis: post.emojis,
    sensitive: post.sensitive,
    url: post.url,
  }).onConflictDoNothing().returning();
  if (posts.length < 1) {
    const share = await db.query.postTable.findFirst({
      where: {
        actorId: actor.id,
        sharedPostId: post.id,
      },
    });
    return share!;
  }
  const share = posts[0];
  post.sharesCount = await updateSharesCount(db, post, 1);
  share.sharesCount = post.sharesCount;
  await addPostToTimeline(db, share);

  // Create a share notification for the original post's author
  if (post.actor.accountId != null) {
    const notification = await createShareNotification(
      db,
      post.actor.accountId,
      post,
      actor,
      share.published,
    );
    logger.debug("Created share notification for {accountId}: {notification}", {
      accountId: post.actor.accountId,
      notification,
    });
  }
  const announce = getAnnounce(fedCtx, {
    ...share,
    sharedPost: post,
    actor: { ...actor, account },
    mentions: [],
  });
  await fedCtx.sendActivity(
    { identifier: account.id },
    "followers",
    announce,
    { preferSharedInbox: true, excludeBaseUris: [new URL(fedCtx.origin)] },
  );
  await fedCtx.sendActivity(
    { identifier: account.id },
    toRecipient(post.actor),
    announce,
    { excludeBaseUris: [new URL(fedCtx.origin)] },
  );
  return share;
}

export async function unsharePost(
  fedCtx: Context<ContextData>,
  account: Account & {
    emails: AccountEmail[];
    links: AccountLink[];
  },
  sharedPost: Post & { actor: Actor },
): Promise<Post | undefined> {
  if (sharedPost.sharedPostId != null) return;
  const { db } = fedCtx.data;
  const actor = await syncActorFromAccount(fedCtx, account);
  const unshared = await db.delete(postTable).where(
    and(
      eq(postTable.actorId, actor.id),
      eq(postTable.sharedPostId, sharedPost.id),
    ),
  ).returning();
  if (unshared.length < 1) return undefined;
  sharedPost.sharesCount = await updateSharesCount(db, sharedPost, -1);
  await removeFromTimeline(db, unshared[0]);
  if (sharedPost.actor.accountId != null) {
    await deleteShareNotification(
      db,
      sharedPost.actor.accountId,
      sharedPost,
      actor,
    );
  }
  const announce = getAnnounce(fedCtx, {
    ...unshared[0],
    actor,
    sharedPost,
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
    { preferSharedInbox: true, excludeBaseUris: [new URL(fedCtx.origin)] },
  );
  await fedCtx.sendActivity(
    { identifier: account.id },
    toRecipient(sharedPost.actor),
    undo,
    { excludeBaseUris: [new URL(fedCtx.origin)] },
  );
  return unshared[0];
}

export async function isPostSharedBy(
  db: Database,
  post: Post,
  account?: Account & { actor: Actor } | null,
): Promise<boolean> {
  if (account == null) return false;
  const rows = await db.select({ id: postTable.id })
    .from(postTable)
    .where(
      and(
        eq(postTable.actorId, account.actor.id),
        eq(postTable.sharedPostId, post.id),
      ),
    )
    .limit(1);
  return rows.length > 0;
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
  if (deletedPost.replyTargetId == null) return true;
  const replyTarget = await db.query.postTable.findFirst({
    where: { id: deletedPost.replyTargetId },
  });
  if (replyTarget == null) return true;
  await updateRepliesCount(db, replyTarget, -1);
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
  },
  actor?: Actor | { iri: string },
): boolean {
  if (actor != null) {
    if (
      "id" in actor && post.actor.id === actor.id ||
      "iri" in actor && post.actor.iri === actor.iri
    ) {
      return true;
    }
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
    } satisfies RelationsFilter<"postTable">;
  }
  if ("accountId" in actorOrPost) {
    return {
      actor: {
        NOT: {
          OR: [
            { blockees: { blockeeId: actorOrPost.id } },
            { blockers: { blockerId: actorOrPost.id } },
          ],
        },
      },
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
      return {
        NOT: {
          OR: [
            { blockees: { blockeeId: actorOrPost.actorId } },
            { blockers: { blockerId: actorOrPost.actorId } },
          ],
        },
      } satisfies RelationsFilter<"actorTable">;
    }
    return {
      AND: [
        {
          NOT: {
            OR: [
              { blockees: { blockeeId: actorOrPost.actorId } },
              { blockers: { blockerId: actorOrPost.actorId } },
            ],
          },
        },
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
  db: Database,
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
  if (post.replyTarget != null) {
    await updateRepliesCount(db, post.replyTarget, -1);
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
    where: { id: { in: interactions.map((i) => i.actorId) } },
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
    object: new vocab.Tombstone({
      id: new URL(post.iri),
    }),
  });
  await fedCtx.sendActivity(
    { identifier: post.actor.accountId },
    "followers",
    activity,
    {
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  await fedCtx.sendActivity(
    { identifier: post.actor.accountId },
    recipients,
    activity,
    {
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
}

export async function scrapePostLink<TContextData>(
  fedCtx: Context<TContextData>,
  url: string | URL,
  handleToActorId: (handle: string) => Promise<Uuid | undefined>,
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
    });
  } catch (error) {
    lg.error("Failed to fetch {url}: {error}", { url: url.href, error });
    return undefined;
  }
  const responseUrl = response.url == null || response.url === ""
    ? url.href
    : response.url;
  if (!response.ok) {
    lg.error("Failed to scrape {url}: {status} {statusText}", {
      url: responseUrl,
      status: response.status,
      statusText: response.statusText,
    });
    return undefined;
  }
  const fullContentType = response.headers.get("Content-Type");
  const contentType = fullContentType?.replace(/\s*;.*$/, "");
  if (
    contentType === "application/pdf" || contentType === "application/x-pdf"
  ) {
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
  }
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    lg.warn("Not an HTML page: {url} ({contentType})", {
      url: responseUrl,
      contentType,
    });
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
  const bytes = await response.bytes();
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
  const { error, result } = await ogs({
    html,
    customMetaTags: [
      {
        multiple: false,
        property: "fediverse:creator",
        fieldName: "fediverseCreator",
      },
    ],
  });
  if (error) {
    lg.error("Failed to scrape {url}: {error}", { url: responseUrl, result });
    return undefined;
  }
  lg.debug("Scraped {url}: {result}", { url: responseUrl, result });
  const ogImage = result.ogImage ?? [];
  const twitterImage = result.twitterImage ?? [];
  let image = ogImage.length > 0
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
    const response = await fetch(image.imageUrl, {
      headers: {
        "User-Agent": getUserAgent({
          software: "HackersPub",
          url: new URL(fedCtx.canonicalOrigin),
        }),
        "Accept": "image/*",
        "Referer": responseUrl,
      },
      redirect: "follow",
    });
    logger.debug("Fetched image {url}: {status} {statusText}", {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
    });
    if (response.ok) {
      const body = await response.arrayBuffer();
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
        image = {};
      }
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
