import {
  type Context,
  type DocumentLoader,
  LanguageString,
} from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { eq } from "drizzle-orm";
import Keyv from "keyv";
import type { Database } from "../db.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  type ArticleSource,
  type Instance,
  type NewPost,
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

export async function persistPost(
  db: Database,
  post: PostObject,
  options: {
    actor?: Actor & { instance: Instance };
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
  let actor = options.actor ?? await getPersistedActor(db, post.attributionId);
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
  for await (const tag of post.getTags(options)) {
    if (tag instanceof vocab.Hashtag) {
      if (tag.name == null || tag.href == null) continue;
      tags[tag.name.toString()] = tag.href.href;
    }
  }
  // TODO: Persist reply target
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
  return { ...rows[0], actor };
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
  let actor: Actor & { instance: Instance } | undefined = options.actor ??
    await getPersistedActor(db, announce.actorId);
  if (actor == null) {
    const apActor = await announce.getActor(options);
    if (apActor == null) return;
    actor = await persistActor(db, apActor, options);
    if (actor == null) return;
  }
  const object = await announce.getObject(options);
  if (!isPostObject(object)) return;
  const post = await persistPost(db, object, options);
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

const UNREACHABLE: never = undefined!;
