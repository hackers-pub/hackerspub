import {
  type Context,
  LanguageString,
  PUBLIC_COLLECTION,
} from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { renderMarkup } from "../models/markup.ts";
import {
  type Account,
  type ArticleSource,
  articleSourceTable,
  type NoteSource,
  noteSourceTable,
} from "../models/schema.ts";
import { validateUuid } from "../models/uuid.ts";
import { federation } from "./federation.ts";

export async function getArticle(
  ctx: Context<void>,
  articleSource: ArticleSource & { account: Account },
): Promise<vocab.Article> {
  const rendered = await renderMarkup(
    articleSource.id,
    articleSource.content,
  );
  return new vocab.Article({
    id: ctx.getObjectUri(vocab.Article, { id: articleSource.id }),
    attribution: ctx.getActorUri(articleSource.accountId),
    to: PUBLIC_COLLECTION,
    cc: ctx.getFollowersUri(articleSource.accountId),
    names: [
      new LanguageString(articleSource.title, articleSource.language),
      articleSource.title,
    ],
    contents: [
      new LanguageString(rendered.html, articleSource.language),
      rendered.html,
    ],
    source: new vocab.Source({
      content: articleSource.content,
      mediaType: "text/markdown",
    }),
    tags: articleSource.tags.map((tag) =>
      new vocab.Hashtag({
        name: tag,
        href: new URL(`/tags/${encodeURIComponent(tag)}`, ctx.origin),
      })
    ),
    url: new URL(
      `/@${articleSource.account.username}/${articleSource.publishedYear}/${
        encodeURIComponent(articleSource.slug)
      }`,
      ctx.origin,
    ),
    published: articleSource.published.toTemporalInstant(),
    updated: +articleSource.updated > +articleSource.published
      ? articleSource.updated.toTemporalInstant()
      : null,
  });
}

federation.setObjectDispatcher(
  vocab.Article,
  "/ap/articles/{id}",
  async (ctx, values) => {
    if (!validateUuid(values.id)) return null;
    const articleSource = await db.query.articleSourceTable.findFirst({
      with: { account: true },
      where: eq(articleSourceTable.id, values.id),
    });
    if (articleSource == null) return null;
    return await getArticle(ctx, articleSource);
  },
);

export function getNote(
  ctx: Context<void>,
  note: NoteSource & { account: Account },
): Promise<vocab.Note> {
  const noteObject = new vocab.Note({
    id: ctx.getObjectUri(vocab.Note, { id: note.id }),
    attribution: ctx.getActorUri(note.accountId),
    to: note.visibility === "public"
      ? PUBLIC_COLLECTION
      : note.visibility === "unlisted" || note.visibility === "followers"
      ? ctx.getFollowersUri(note.accountId)
      : null, // TODO: direct messages
    cc: note.visibility === "public"
      ? ctx.getFollowersUri(note.accountId)
      : note.visibility === "unlisted"
      ? PUBLIC_COLLECTION
      : null,
    contents: [
      new LanguageString(note.content, note.language),
      note.content,
    ],
    source: new vocab.Source({
      content: note.content,
      mediaType: "text/markdown",
    }),
    url: new URL(
      `/@${note.account.username}/${note.id}`,
      ctx.origin,
    ),
    published: note.published.toTemporalInstant(),
    updated: +note.updated > +note.published
      ? note.updated.toTemporalInstant()
      : null,
  });
  return Promise.resolve(noteObject);
}

federation.setObjectDispatcher(
  vocab.Note,
  "/ap/notes/{id}",
  async (ctx, values) => {
    if (!validateUuid(values.id)) return null;
    const note = await db.query.noteSourceTable.findFirst({
      with: { account: true },
      where: eq(noteSourceTable.id, values.id),
    });
    if (note == null) return null;
    return await getNote(ctx, note);
  },
);
