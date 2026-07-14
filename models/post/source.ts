import * as vocab from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { eq, sql } from "drizzle-orm";
import { syncActorFromAccount } from "../actor.ts";
import {
  getArticleSourceMediumUrls,
  getOriginalArticleContent,
} from "../article-source.ts";
import type { ApplicationContext } from "../context.ts";
import { extractExternalLinks } from "../html.ts";
import { persistPostLink } from "../link-preview.ts";
import { getMissingArticleMediumLabel, renderMarkup } from "../markup.ts";
import { refreshNewsScores } from "../news.ts";
import { createPoll, type CreatePollInput } from "../poll.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  type ArticleContent,
  type ArticleSource,
  type Instance,
  type Medium,
  type Mention,
  mentionTable,
  type NewPost,
  type NoteSource,
  type NoteSourceMedium,
  type Poll,
  type PollOption,
  type Post,
  type PostMedium,
  postMediumTable,
  postTable,
  quoteAuthorizationTable,
} from "../schema.ts";
import { generateUuidV7 } from "../uuid.ts";
import { updateQuotesCount } from "./engagement.ts";
import {
  createTargetPostUpdatedNotifications,
  persistArticleNewsLink,
} from "./persistence.ts";
import {
  canActorQuotePost,
  getAllowedQuoteTargetForActor,
  normalizeQuotePolicyForVisibility,
  type QuotePolicyPost,
} from "./visibility.ts";

const logger = getLogger(["hackerspub", "models", "post", "source"]);

type NoteSourceMediumWithMedium = NoteSourceMedium & { medium: Medium };

export async function syncPostFromArticleSource(
  fedCtx: ApplicationContext,
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
  const { db, kv, storage: disk } = fedCtx;
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
  fedCtx: ApplicationContext,
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
  const { db, kv, storage: disk } = fedCtx;
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
    // Keep the exact URL the author shared for navigation.  The PostLink URL
    // is a fragment-less fetch/aggregation identity and may differ after an
    // HTTP redirect; neither should replace the author's query or fragment.
    linkUrl: link == null ? null : externalLinks[0].href,
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
