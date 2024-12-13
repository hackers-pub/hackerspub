import {
  type Context,
  type DocumentLoader,
  isActor,
  LanguageString,
  lookupObject,
  traverseCollection,
} from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { eq, inArray } from "drizzle-orm";
import Keyv from "keyv";
import type { Database } from "../db.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  actorTable,
  type ArticleSource,
  type Instance,
  mentionTable,
  type NewPost,
  type NoteSource,
  type Post,
  postTable,
} from "./schema.ts";
import {
  getPersistedActor,
  persistActor,
  syncActorFromAccount,
} from "./actor.ts";
import { renderMarkup } from "./markup.ts";
import { generateUuidV7 } from "./uuid.ts";
import { toDate } from "./date.ts";

const logger = getLogger(["hackerspub", "models", "post"]);

export type PostObject = vocab.Article | vocab.Note | vocab.Question;

export function isPostObject(object: unknown): object is PostObject {
  return object instanceof vocab.Article || object instanceof vocab.Note ||
    object instanceof vocab.Question;
}

export async function syncPostFromArticleSource(
  db: Database,
  kv: Keyv,
  fedCtx: Context<void>,
  articleSource: ArticleSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
  },
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    articleSource: ArticleSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    };
  }
> {
  const actor = await syncActorFromAccount(
    db,
    kv,
    fedCtx,
    articleSource.account,
  );
  const rendered = await renderMarkup(articleSource.id, articleSource.content);
  const url =
    `${fedCtx.origin}/@${articleSource.account.username}/${articleSource.publishedYear}/${
      encodeURIComponent(articleSource.slug)
    }`;
  const values: Omit<NewPost, "id"> = {
    iri: fedCtx.getObjectUri(vocab.Article, { id: articleSource.id }).href,
    type: "Article",
    actorId: actor.id,
    articleSourceId: articleSource.id,
    name: articleSource.title,
    contentHtml: rendered.html,
    language: articleSource.language,
    tags: Object.fromEntries(
      articleSource.tags.map((
        tag,
      ) => [tag, `${fedCtx.origin}/tags/${encodeURIComponent(tag)}`]),
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
  return { ...rows[0], actor, articleSource };
}

export async function syncPostFromNoteSource(
  db: Database,
  kv: Keyv,
  fedCtx: Context<void>,
  noteSource: NoteSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
  },
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    };
  }
> {
  const actor = await syncActorFromAccount(
    db,
    kv,
    fedCtx,
    noteSource.account,
  );
  // FIXME: Note should be rendered in a different way
  const rendered = await renderMarkup(noteSource.id, noteSource.content);
  const url =
    `${fedCtx.origin}/@${noteSource.account.username}/${noteSource.id}`;
  const values: Omit<NewPost, "id"> = {
    iri: fedCtx.getObjectUri(vocab.Note, { id: noteSource.id }).href,
    type: "Note",
    actorId: actor.id,
    noteSourceId: noteSource.id,
    contentHtml: rendered.html,
    language: noteSource.language,
    tags: {}, // TODO
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
  return { ...rows[0], actor, noteSource };
}

export async function persistPost(
  db: Database,
  post: PostObject,
  options: {
    actor?: Actor & { instance: Instance };
    replyTarget?: Post & { actor: Actor & { instance: Instance } };
    replies?: boolean;
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<Post & { actor: Actor & { instance: Instance } } | undefined> {
  if (post.id == null || post.attributionId == null || post.content == null) {
    logger.debug(
      "Missing required fields (id, attributedTo, content): {post}",
      { post },
    );
    return;
  }
  let actor =
    options.actor == null || options.actor.iri !== post.attributionId.href
      ? await getPersistedActor(db, post.attributionId)
      : options.actor;
  if (actor == null) {
    const apActor = await post.getAttribution(options);
    if (apActor == null) return;
    actor = await persistActor(db, apActor, options);
    if (actor == null) {
      logger.debug("Failed to persist actor: {actor}", { actor: apActor });
      return;
    }
  }
  const tags: Record<string, string> = {};
  const mentions = new Set<string>();
  for await (const tag of post.getTags(options)) {
    if (tag instanceof vocab.Hashtag) {
      if (tag.name == null || tag.href == null) continue;
      tags[tag.name.toString().replace(/^#/, "")] = tag.href.href;
    } else if (tag instanceof vocab.Mention) {
      if (tag.href == null) continue;
      mentions.add(tag.href.href);
    }
  }
  let replyTarget: Post & { actor: Actor & { instance: Instance } } | undefined;
  if (post.replyTargetId != null) {
    replyTarget = options.replyTarget ??
      await getPersistedPost(db, post.replyTargetId);
    if (replyTarget == null) {
      const apReplyTarget = await post.getReplyTarget(options);
      if (!isPostObject(apReplyTarget)) return;
      replyTarget = await persistPost(db, apReplyTarget, options);
      if (replyTarget == null) return;
    }
  }
  const values: Omit<NewPost, "id"> = {
    iri: post.id.href,
    type: post instanceof vocab.Article
      ? "Article"
      : post instanceof vocab.Note
      ? "Note"
      : post instanceof vocab.Question
      ? "Question"
      : UNREACHABLE,
    actorId: actor.id,
    name: post.name?.toString(),
    contentHtml: post.content?.toString(),
    language: post.content instanceof LanguageString
      ? post.content.language.compact()
      : post.contents.length > 1 && post.contents[1] instanceof LanguageString
      ? post.contents[1].language.compact()
      : undefined,
    tags,
    url: post.url instanceof vocab.Link ? post.url.href?.href : post.url?.href,
    replyTargetId: replyTarget?.id,
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
  if (mentions.size > 0) {
    const mentionedActors = await db.query.actorTable.findMany({
      where: inArray(actorTable.iri, [...mentions]),
    });
    for (const mentionedActor of mentionedActors) {
      mentions.delete(mentionedActor.iri);
    }
    if (mentions.size > 0) {
      for (const iri of mentions) {
        const apActor = await lookupObject(iri, options);
        if (!isActor(apActor)) continue;
        const actor = await persistActor(db, apActor, options);
        if (actor == null) continue;
        mentionedActors.push(actor);
      }
    }
    await db.insert(mentionTable)
      .values(
        mentionedActors.map((actor) => ({
          postId: persistedPost.id,
          actorId: actor.id,
        })),
      )
      .onConflictDoNothing()
      .execute();
  }
  if (options.replies) {
    const replies = await post.getReplies(options);
    if (replies != null) {
      for await (
        const reply of traverseCollection(replies, {
          ...options,
          suppressError: true,
        })
      ) {
        if (!isPostObject(reply)) continue;
        await persistPost(db, reply, {
          ...options,
          actor,
          replyTarget: persistedPost,
        });
      }
    }
  }
  return persistedPost;
}

export async function persistSharedPost(
  db: Database,
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
  let actor: Actor & { instance: Instance } | undefined =
    options.actor == null || options.actor.iri !== announce.actorId.href
      ? await getPersistedActor(db, announce.actorId)
      : options.actor;
  if (actor == null) {
    const apActor = await announce.getActor(options);
    if (apActor == null) return;
    actor = await persistActor(db, apActor, options);
    if (actor == null) return;
  }
  const object = await announce.getObject(options);
  if (!isPostObject(object)) return;
  const post = await persistPost(db, object, {
    ...options,
    replies: true,
  });
  if (post == null) return;
  const values: Omit<NewPost, "id"> = {
    iri: announce.id.href,
    type: post.type,
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
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.iri,
      set: values,
      setWhere: eq(postTable.iri, announce.id.href),
    })
    .returning();
  return { ...rows[0], actor, sharedPost: post };
}

export function getPersistedPost(
  db: Database,
  iri: URL,
): Promise<Post & { actor: Actor & { instance: Instance } } | undefined> {
  return db.query.postTable.findFirst({
    with: { actor: { with: { instance: true } } },
    where: eq(postTable.iri, iri.toString()),
  });
}

const UNREACHABLE: never = undefined!;
