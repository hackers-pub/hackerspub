import {
  type Context,
  LanguageString,
  PUBLIC_COLLECTION,
} from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { escape } from "@std/html/entities";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Disk } from "flydrive";
import { type Database, db } from "../db.ts";
import { drive } from "../drive.ts";
import { renderMarkup } from "../models/markup.ts";
import { isPostVisibleTo } from "../models/post.ts";
import {
  type Account,
  type Actor,
  type ArticleSource,
  articleSourceTable,
  type Mention,
  type NoteMedium,
  type NoteSource,
  noteSourceTable,
  type Post,
  postTable,
  type PostVisibility,
} from "../models/schema.ts";
import { type Uuid, validateUuid } from "../models/uuid.ts";
import { federation } from "./federation.ts";

export async function getArticle(
  db: Database,
  ctx: Context<void>,
  articleSource: ArticleSource & { account: Account },
): Promise<vocab.Article> {
  const rendered = await renderMarkup(
    db,
    ctx,
    articleSource.id,
    articleSource.content,
  );
  return new vocab.Article({
    id: ctx.getObjectUri(vocab.Article, { id: articleSource.id }),
    attribution: ctx.getActorUri(articleSource.accountId),
    to: PUBLIC_COLLECTION,
    cc: ctx.getFollowersUri(articleSource.accountId),
    names: [
      articleSource.title,
      new LanguageString(articleSource.title, articleSource.language),
    ],
    contents: [
      rendered.html,
      new LanguageString(rendered.html, articleSource.language),
    ],
    source: new vocab.Source({
      content: articleSource.content,
      mediaType: "text/markdown",
    }),
    tags: articleSource.tags.map((tag) =>
      new vocab.Hashtag({
        name: tag,
        href: new URL(`/tags/${encodeURIComponent(tag)}`, ctx.canonicalOrigin),
      })
    ),
    url: new URL(
      `/@${articleSource.account.username}/${articleSource.publishedYear}/${
        encodeURIComponent(articleSource.slug)
      }`,
      ctx.canonicalOrigin,
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
    return await getArticle(db, ctx, articleSource);
  },
);

export interface RecipientSet {
  readonly tos: URL[];
  readonly ccs: URL[];
}

export function getPostRecipients(
  ctx: Context<void>,
  accountId: Uuid,
  mentionedActorIds: URL[],
  visibility: PostVisibility,
): RecipientSet {
  return {
    tos: [
      ...(visibility === "public"
        ? [PUBLIC_COLLECTION]
        : visibility === "unlisted" || visibility === "followers"
        ? [ctx.getFollowersUri(accountId)]
        : []),
      ...mentionedActorIds,
    ],
    ccs: visibility === "public"
      ? [ctx.getFollowersUri(accountId)]
      : visibility === "unlisted"
      ? [PUBLIC_COLLECTION]
      : [],
  };
}

export async function getNote(
  db: Database,
  disk: Disk,
  ctx: Context<void>,
  note: NoteSource & { account: Account; media: NoteMedium[] },
  relations: {
    replyTargetId?: URL;
    quotedPost?: Post;
  } = {},
): Promise<vocab.Note> {
  const rendered = await renderMarkup(db, ctx, note.id, note.content);
  const attachments: vocab.Document[] = [];
  for (const medium of note.media) {
    attachments.push(
      new vocab.Document({
        mediaType: "image/webp",
        url: new URL(await disk.getUrl(medium.key)),
        name: medium.alt,
        width: medium.width,
        height: medium.height,
      }),
    );
  }
  const tags: vocab.Link[] = Object.entries(rendered.mentions)
    .map(([handle, actor]) =>
      new vocab.Mention({
        href: new URL(actor.iri),
        name: handle,
      })
    );
  let contentHtml = rendered.html;
  if (relations.quotedPost != null) {
    const quoteUrl = relations.quotedPost.url ?? relations.quotedPost.iri;
    tags.push(
      new vocab.Link({
        mediaType: "application/activity+json",
        href: new URL(relations.quotedPost.iri),
        name: `RE: ${quoteUrl}`,
      }),
    );
    contentHtml =
      `${contentHtml}<p class="quote-inline"><span class="quote-inline"><br><br>` +
      `RE: <a href="${escape(quoteUrl)}">${escape(quoteUrl)}</a></span></p>`;
  }
  return new vocab.Note({
    id: ctx.getObjectUri(vocab.Note, { id: note.id }),
    attribution: ctx.getActorUri(note.accountId),
    ...getPostRecipients(
      ctx,
      note.accountId,
      Object.values(rendered.mentions).map((actor) => new URL(actor.iri)),
      note.visibility,
    ),
    replyTarget: relations.replyTargetId,
    quoteUrl: relations.quotedPost == null
      ? null
      : new URL(relations.quotedPost.iri),
    contents: [
      contentHtml,
      new LanguageString(contentHtml, note.language),
    ],
    source: new vocab.Source({
      content: note.content,
      mediaType: "text/markdown",
    }),
    attachments,
    tags,
    url: new URL(
      `/@${note.account.username}/${note.id}`,
      ctx.canonicalOrigin,
    ),
    published: note.published.toTemporalInstant(),
    updated: +note.updated > +note.published
      ? note.updated.toTemporalInstant()
      : null,
  });
}

federation
  .setObjectDispatcher(
    vocab.Note,
    "/ap/notes/{id}",
    async (ctx, values) => {
      if (!validateUuid(values.id)) return null;
      const note = await db.query.noteSourceTable.findFirst({
        with: {
          account: true,
          media: true,
          post: { with: { replyTarget: true, quotedPost: true } },
        },
        where: eq(noteSourceTable.id, values.id),
      });
      if (note == null) return null;
      const disk = drive.use();
      return await getNote(
        db,
        disk,
        ctx,
        note,
        {
          replyTargetId: note.post.replyTarget == null
            ? undefined
            : new URL(note.post.replyTarget.iri),
          quotedPost: note.post.quotedPost ?? undefined,
        },
      );
    },
  )
  .authorize(async (ctx, values) => {
    if (!validateUuid(values.id)) return false;
    const post = await db.query.postTable.findFirst({
      with: {
        actor: {
          with: {
            followers: {
              with: { follower: true },
            },
          },
        },
        mentions: {
          with: { actor: true },
        },
      },
      where: eq(postTable.noteSourceId, values.id),
    });
    if (post == null || post.actor.accountId == null) return false;
    const documentLoader = await ctx.getDocumentLoader({
      identifier: post.actor.accountId,
    });
    const signedKeyOwner = await ctx.getSignedKeyOwner({ documentLoader });
    return isPostVisibleTo(
      post,
      signedKeyOwner?.id == null ? undefined : { iri: signedKeyOwner.id.href },
    );
  });

export function getAnnounce(
  ctx: Context<void>,
  share: Post & {
    actor: Actor & { account: Account };
    sharedPost: Post;
    mentions: (Mention & { actor: Actor })[];
  },
): vocab.Announce {
  return new vocab.Announce({
    id: ctx.getObjectUri(vocab.Announce, { id: share.id }),
    actor: ctx.getActorUri(share.actor.account.id),
    ...getPostRecipients(
      ctx,
      share.actor.account.id,
      share.mentions.map((m) => new URL(m.actor.iri)),
      share.visibility,
    ),
    object: new URL(share.sharedPost.iri),
    published: share.published.toTemporalInstant(),
  });
}

federation.setObjectDispatcher(
  vocab.Announce,
  "/ap/announces/{id}",
  async (ctx, values) => {
    if (!validateUuid(values.id)) return null;
    const share = await db.query.postTable.findFirst({
      with: {
        actor: { with: { account: true } },
        sharedPost: true,
        mentions: { with: { actor: true } },
      },
      where: and(
        eq(postTable.id, values.id),
        isNotNull(postTable.sharedPostId),
      ),
    });
    if (
      share == null || share.actor.account == null || share.sharedPost == null
    ) {
      return null;
    }
    return getAnnounce(ctx, {
      ...share,
      sharedPost: share.sharedPost,
      actor: { ...share.actor, account: share.actor.account },
    });
  },
);
