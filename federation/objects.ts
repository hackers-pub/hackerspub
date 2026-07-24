import type { Context, RequestContext } from "@fedify/fedify";
import { LanguageString, PUBLIC_COLLECTION } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import { toApplicationContext } from "./context.ts";
import {
  DEFAULT_REACTION_EMOJI,
  isReactionEmoji,
  type ReactionEmoji,
} from "@hackerspub/models/emoji";
import { removeHeaderAnchorLinks } from "@hackerspub/models/html";
import {
  getMissingArticleMediumLabel,
  renderMarkup,
  resolveMediumUrls,
} from "@hackerspub/models/markup";
import {
  getCensoredPostExclusionFilter,
  getPostVisibilityFilter,
  getSanctionVisibleActorFilter,
  isActorSanctionHidden,
  isPostVisibleTo,
  normalizeQuotePolicyForVisibility,
} from "@hackerspub/models/post/visibility";
import type {
  Account,
  Actor,
  ArticleContent,
  ArticleSource,
  CustomEmoji,
  Medium,
  Mention,
  NoteSource,
  NoteSourceMedium,
  OrganizationPostAuthor,
  Poll,
  PollOption,
  Post,
  PostVisibility,
  QuotePolicy,
  Reaction,
} from "@hackerspub/models/schema";
import {
  actorTable,
  postTable,
  reactionTable,
} from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { escape } from "@std/html/entities";
import {
  aliasedTable,
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
} from "drizzle-orm";
import { builder } from "./builder.ts";

const EMOJI_REACTIONS_WINDOW = 50;
const REPLIES_WINDOW = 50;

type EmojiReactableObject = "articles" | "notes" | "questions";
type ReplyCollectionObject = "articles" | "notes" | "questions";

function isPublicPostVisibility(visibility: PostVisibility): boolean {
  return visibility === "public" || visibility === "unlisted";
}

function getRepliesUri(
  ctx: Context<ContextData>,
  object: ReplyCollectionObject,
  id: Uuid,
): URL {
  return new URL(`/ap/replies/${object}/${id}`, ctx.canonicalOrigin);
}

function getRepliesPageUri(
  ctx: Context<ContextData>,
  object: ReplyCollectionObject,
  id: Uuid,
  cursor: string,
): URL {
  return new URL(
    `/ap/replies/${object}/${id}/page/${cursor}`,
    ctx.canonicalOrigin,
  );
}

function getEmojiReactionsUri(
  ctx: Context<ContextData>,
  object: EmojiReactableObject,
  id: Uuid,
): URL {
  // A nested object URL such as `/ap/notes/{id}/emoji-reactions` would be more
  // natural, but this separate namespace keeps the temporary dispatcher
  // workaround local until https://github.com/fedify-dev/fedify/issues/849 is
  // fixed.
  return new URL(`/ap/emoji-reactions/${object}/${id}`, ctx.canonicalOrigin);
}

function getEmojiReactionsPageUri(
  ctx: Context<ContextData>,
  object: EmojiReactableObject,
  id: Uuid,
  cursor: string,
): URL {
  return new URL(
    `/ap/emoji-reactions/${object}/${id}/page/${cursor}`,
    ctx.canonicalOrigin,
  );
}

export function getPostAttributionIds(
  ctx: Context<ContextData>,
  accountId: Uuid,
  organizationAuthor?: Pick<
    OrganizationPostAuthor,
    "organizationAccountId" | "memberAccountId" | "attributionMode"
  > | null,
): URL[] {
  if (
    organizationAuthor?.attributionMode !== "acting_account_with_viewer" ||
    organizationAuthor.organizationAccountId !== accountId
  ) {
    return [ctx.getActorUri(accountId)];
  }
  return [
    ctx.getActorUri(organizationAuthor.organizationAccountId),
    ctx.getActorUri(organizationAuthor.memberAccountId),
  ];
}

async function getArticleAttributionIds(
  ctx: Context<ContextData>,
  articleSource: Pick<ArticleSource, "id" | "accountId">,
): Promise<URL[]> {
  const post = await ctx.data.db.query.postTable.findFirst({
    columns: { id: true },
    with: { organizationAuthor: true },
    where: { articleSourceId: articleSource.id },
  });
  return getPostAttributionIds(
    ctx,
    articleSource.accountId,
    post?.organizationAuthor,
  );
}

async function getNoteAttributionIds(
  ctx: Context<ContextData>,
  note: Pick<NoteSource, "id" | "accountId">,
): Promise<URL[]> {
  const post = await ctx.data.db.query.postTable.findFirst({
    columns: { id: true },
    with: { organizationAuthor: true },
    where: { noteSourceId: note.id },
  });
  return getPostAttributionIds(ctx, note.accountId, post?.organizationAuthor);
}

export async function getArticle(
  ctx: Context<ContextData>,
  articleSource: ArticleSource & {
    account: Account;
    contents: ArticleContent[];
  },
): Promise<vocab.Article> {
  const sourceMedia = await ctx.data.db.query.articleSourceMediumTable.findMany(
    {
      where: { articleSourceId: articleSource.id },
      with: { medium: true },
    },
  );
  const mediumUrls = Object.fromEntries(
    await Promise.all(
      sourceMedia.map(async (relation) => [
        relation.key,
        await ctx.data.disk.getUrl(relation.medium.key),
      ]),
    ),
  );
  const url = new URL(
    `/@${articleSource.account.username}/${articleSource.publishedYear}/${encodeURIComponent(
      articleSource.slug,
    )}`,
    ctx.canonicalOrigin,
  );
  const contents = await Promise.all(
    articleSource.contents.map(async (content) => {
      const missingMediumLabel = getMissingArticleMediumLabel(content.language);
      const { hashtags, html } = await renderMarkup(
        toApplicationContext(ctx),
        content.content,
        {
          docId: articleSource.id,
          kv: ctx.data.kv,
          mediumUrls,
          missingMediumLabel,
        },
      );
      return {
        ...content,
        hashtags,
        html: removeHeaderAnchorLinks(html),
        content: resolveMediumUrls(content.content, mediumUrls, {
          missingMediumLabel,
        }),
      };
    }),
  );
  const hashtags = contents.flatMap((c) => c.hashtags);
  contents.sort((a, b) => a.published.valueOf() - b.published.valueOf());
  let content: string | null = null;
  if (contents.length > 1) {
    content = "<nav><ul>";
    const displayNames = new Intl.DisplayNames(contents[0].language, {
      type: "language",
    });
    for (const c of contents.slice(1)) {
      const nativeLangName =
        new Intl.DisplayNames(c.language, { type: "language" }).of(
          c.language,
        ) ?? "";
      const langName = displayNames.of(c.language) ?? "";
      content += `<li lang="${escape(c.language)}">${escape(nativeLangName)} (${escape(
        langName,
      )}): <a hreflang="${escape(c.language)}" href="${escape(url.href)}/${escape(
        encodeURIComponent(c.language),
      )}">${escape(c.title)}</a></li>\n`;
    }
    content += `</ul></nav>\n<hr>\n${contents[0].html}`;
  } else if (contents.length > 0) {
    content = contents[0].html;
  }
  return new vocab.Article({
    id: ctx.getObjectUri(vocab.Article, { id: articleSource.id }),
    attributions: await getArticleAttributionIds(ctx, articleSource),
    to: PUBLIC_COLLECTION,
    cc: ctx.getFollowersUri(articleSource.accountId),
    interactionPolicy: getQuoteInteractionPolicy(
      ctx,
      articleSource.accountId,
      articleSource.quotePolicy,
    ),
    names: [
      ...(contents.length > 0 ? [contents[0].title] : []),
      ...contents.map((c) => new LanguageString(c.title, c.language)),
    ],
    contents: [
      ...(content ? [content] : []),
      ...contents.map((c) => new LanguageString(c.html, c.language)),
    ],
    source:
      contents.length > 0
        ? new vocab.Source({
            content: contents[0].content,
            mediaType: "text/markdown",
          })
        : null,
    replies: getRepliesUri(ctx, "articles", articleSource.id),
    emojiReactions: getEmojiReactionsUri(ctx, "articles", articleSource.id),
    tags: [...articleSource.tags, ...hashtags].map(
      (tag) =>
        new vocab.Hashtag({
          name: `#${tag.replace(/^#/, "")}`,
          href: new URL(
            `/tags/${encodeURIComponent(tag.replace(/^#/, ""))}`,
            ctx.canonicalOrigin,
          ),
        }),
    ),
    url,
    published: articleSource.published.toTemporalInstant(),
    updated:
      +articleSource.updated > +articleSource.published
        ? articleSource.updated.toTemporalInstant()
        : null,
  });
}

function getQuoteInteractionPolicy(
  ctx: Context<ContextData>,
  accountId: Uuid,
  quotePolicy: QuotePolicy,
  quoteRequestPolicy: QuotePolicy | null = null,
): vocab.InteractionPolicy {
  const automaticApproval =
    quotePolicy === "everyone"
      ? PUBLIC_COLLECTION
      : quotePolicy === "followers"
        ? ctx.getFollowersUri(accountId)
        : ctx.getActorUri(accountId);
  const manualApproval =
    quoteRequestPolicy == null
      ? null
      : quoteRequestPolicy === "everyone"
        ? PUBLIC_COLLECTION
        : quoteRequestPolicy === "followers"
          ? ctx.getFollowersUri(accountId)
          : ctx.getActorUri(accountId);
  return new vocab.InteractionPolicy({
    canQuote: new vocab.InteractionRule({
      automaticApproval,
      manualApproval: manualApproval ?? undefined,
    }),
  });
}

builder.setObjectDispatcher(
  vocab.Article,
  "/ap/articles/{id}",
  async (ctx, values) => {
    if (!validateUuid(values.id)) return null;
    const articleSource = await ctx.data.db.query.articleSourceTable.findFirst({
      with: { account: true, contents: true },
      where: { id: values.id },
    });
    if (articleSource == null) return null;
    // Neither a censored article nor one whose author is hidden by a
    // moderation sanction (ban / federation block) is served over
    // ActivityPub; the HTML permalink shows a notice instead.
    const post = await ctx.data.db.query.postTable.findFirst({
      columns: { censored: true },
      with: { actor: true },
      where: { articleSourceId: values.id },
    });
    if (post?.censored != null) return null;
    if (post != null && isActorSanctionHidden(post.actor)) return null;
    return await getArticle(ctx, articleSource);
  },
);

export interface RecipientSet {
  readonly tos: URL[];
  readonly ccs: URL[];
}

export function getPostRecipients(
  ctx: Context<ContextData>,
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
    ccs:
      visibility === "public"
        ? [ctx.getFollowersUri(accountId)]
        : visibility === "unlisted"
          ? [PUBLIC_COLLECTION]
          : [],
  };
}

export async function getNote(
  ctx: Context<ContextData>,
  note: NoteSource & {
    account: Account;
    media: (NoteSourceMedium & { medium: Medium })[];
  },
  relations: {
    replyTargetId?: URL;
    quotedPost?: Post;
    quoteAuthorizationIri?: string | null;
    quoteRequestPolicy?: QuotePolicy | null;
  } = {},
): Promise<vocab.Note> {
  const rendered = await renderMarkup(toApplicationContext(ctx), note.content, {
    docId: note.id,
    kv: ctx.data.kv,
  });
  const { disk } = ctx.data;
  const attachments: vocab.Document[] = [];
  for (const medium of note.media) {
    attachments.push(
      new vocab.Document({
        mediaType: medium.medium.type,
        url: new URL(await disk.getUrl(medium.medium.key)),
        name: medium.alt,
        width: medium.medium.width ?? undefined,
        height: medium.medium.height ?? undefined,
      }),
    );
  }
  const tags: vocab.Link[] = Object.entries(rendered.mentions).map(
    ([handle, actor]) =>
      new vocab.Mention({
        href: new URL(actor.iri),
        name: handle,
      }),
  );
  for (const tag of rendered.hashtags) {
    tags.push(
      new vocab.Hashtag({
        name: `#${tag.replace(/^#/, "")}`,
        href: new URL(
          `/tags/${encodeURIComponent(tag.replace(/^#/, ""))}`,
          ctx.canonicalOrigin,
        ),
      }),
    );
  }
  let contentHtml = removeHeaderAnchorLinks(rendered.html);
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
  const normalizedQuotePolicy = normalizeQuotePolicyForVisibility(
    note.visibility,
    note.quotePolicy,
  );
  return new vocab.Note({
    id: ctx.getObjectUri(vocab.Note, { id: note.id }),
    attributions: await getNoteAttributionIds(ctx, note),
    ...getPostRecipients(
      ctx,
      note.accountId,
      Object.values(rendered.mentions).map((actor) => new URL(actor.iri)),
      note.visibility,
    ),
    replyTarget: relations.replyTargetId,
    interactionPolicy:
      note.visibility === "direct" || note.visibility === "none"
        ? undefined
        : getQuoteInteractionPolicy(
            ctx,
            note.accountId,
            normalizedQuotePolicy,
            relations.quoteRequestPolicy,
          ),
    quote:
      relations.quotedPost == null ? null : new URL(relations.quotedPost.iri),
    quoteUrl:
      relations.quotedPost == null ? null : new URL(relations.quotedPost.iri),
    // No quote authorization without a quote target: when the target is
    // dropped (e.g. censored or sanction-hidden), its authorization URL must
    // not be emitted either, or it would stay dereferenceable and reveal or
    // validate the hidden target.
    quoteAuthorization:
      relations.quotedPost == null || relations.quoteAuthorizationIri == null
        ? null
        : new URL(relations.quoteAuthorizationIri),
    contents: [contentHtml, new LanguageString(contentHtml, note.language)],
    source: new vocab.Source({
      content: note.content,
      mediaType: "text/markdown",
    }),
    replies: isPublicPostVisibility(note.visibility)
      ? getRepliesUri(ctx, "notes", note.id)
      : null,
    emojiReactions: getEmojiReactionsUri(ctx, "notes", note.id),
    attachments,
    tags,
    url: new URL(`/@${note.account.username}/${note.id}`, ctx.canonicalOrigin),
    published: note.published.toTemporalInstant(),
    updated:
      +note.updated > +note.published ? note.updated.toTemporalInstant() : null,
  });
}

export async function getQuestion(
  ctx: Context<ContextData>,
  note: NoteSource & {
    account: Account;
    media: (NoteSourceMedium & { medium: Medium })[];
  },
  poll: Poll & { options: PollOption[]; post: Pick<Post, "name"> },
  relations: {
    replyTargetId?: URL;
    quotedPost?: Post;
    quoteAuthorizationIri?: string | null;
    quoteRequestPolicy?: QuotePolicy | null;
  } = {},
): Promise<vocab.Question> {
  const rendered = await renderMarkup(toApplicationContext(ctx), note.content, {
    docId: note.id,
    kv: ctx.data.kv,
  });
  const { disk } = ctx.data;
  const attachments: vocab.Document[] = [];
  for (const medium of note.media) {
    attachments.push(
      new vocab.Document({
        mediaType: medium.medium.type,
        url: new URL(await disk.getUrl(medium.medium.key)),
        name: medium.alt,
        width: medium.medium.width ?? undefined,
        height: medium.medium.height ?? undefined,
      }),
    );
  }
  const tags: vocab.Link[] = Object.entries(rendered.mentions).map(
    ([handle, actor]) =>
      new vocab.Mention({
        href: new URL(actor.iri),
        name: handle,
      }),
  );
  for (const tag of rendered.hashtags) {
    tags.push(
      new vocab.Hashtag({
        name: `#${tag.replace(/^#/, "")}`,
        href: new URL(
          `/tags/${encodeURIComponent(tag.replace(/^#/, ""))}`,
          ctx.canonicalOrigin,
        ),
      }),
    );
  }
  let contentHtml = removeHeaderAnchorLinks(rendered.html);
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
  const normalizedQuotePolicy = normalizeQuotePolicyForVisibility(
    note.visibility,
    note.quotePolicy,
  );
  const options = poll.options
    .toSorted((a, b) => a.index - b.index)
    .map(
      (option) =>
        new vocab.Note({
          name: option.title,
          replies: new vocab.Collection({
            totalItems: option.votesCount,
          }),
        }),
    );
  return new vocab.Question({
    id: ctx.getObjectUri(vocab.Question, { id: note.id }),
    attributions: await getNoteAttributionIds(ctx, note),
    ...getPostRecipients(
      ctx,
      note.accountId,
      Object.values(rendered.mentions).map((actor) => new URL(actor.iri)),
      note.visibility,
    ),
    replyTarget: relations.replyTargetId,
    interactionPolicy:
      note.visibility === "direct" || note.visibility === "none"
        ? undefined
        : getQuoteInteractionPolicy(
            ctx,
            note.accountId,
            normalizedQuotePolicy,
            relations.quoteRequestPolicy,
          ),
    quote:
      relations.quotedPost == null ? null : new URL(relations.quotedPost.iri),
    quoteUrl:
      relations.quotedPost == null ? null : new URL(relations.quotedPost.iri),
    // No quote authorization without a quote target (see getNote): a dropped
    // (censored or sanction-hidden) target must not leave a dereferenceable
    // authorization URL.
    quoteAuthorization:
      relations.quotedPost == null || relations.quoteAuthorizationIri == null
        ? null
        : new URL(relations.quoteAuthorizationIri),
    name: poll.post.name,
    contents: [contentHtml, new LanguageString(contentHtml, note.language)],
    source: new vocab.Source({
      content: note.content,
      mediaType: "text/markdown",
    }),
    replies: isPublicPostVisibility(note.visibility)
      ? getRepliesUri(ctx, "questions", note.id)
      : null,
    emojiReactions: getEmojiReactionsUri(ctx, "questions", note.id),
    attachments,
    tags,
    url: new URL(`/@${note.account.username}/${note.id}`, ctx.canonicalOrigin),
    endTime: poll.ends.toTemporalInstant(),
    voters: poll.votersCount,
    ...(poll.multiple
      ? { inclusiveOptions: options }
      : { exclusiveOptions: options }),
    published: note.published.toTemporalInstant(),
    updated:
      +note.updated > +note.published ? note.updated.toTemporalInstant() : null,
  });
}

/**
 * Whether a reply or quote target must not be referenced in an outgoing
 * ActivityPub object.  When its own content is moderation-hidden (censored,
 * or authored by a sanction-hidden actor), the dispatcher serializes its
 * `inReplyTo`/quote IRI anyway, and for a remote target that IRI points at
 * the uncensored copy on its origin instance, so the reference is dropped.
 */
export function isApTargetHidden(
  target: (Post & { actor: Actor }) | null | undefined,
): boolean {
  return (
    target != null &&
    (target.censored != null || isActorSanctionHidden(target.actor))
  );
}

builder
  .setObjectDispatcher(vocab.Note, "/ap/notes/{id}", async (ctx, values) => {
    if (!validateUuid(values.id)) return null;
    const note = await ctx.data.db.query.noteSourceTable.findFirst({
      with: {
        account: true,
        media: { with: { medium: true }, orderBy: { index: "asc" } },
        post: {
          where: { type: "Note" },
          with: {
            replyTarget: { with: { actor: true } },
            quotedPost: { with: { actor: true } },
          },
        },
      },
      where: { id: values.id },
    });
    if (note?.post == null) return null;
    // Censored content is not served over ActivityPub.
    if (note.post.censored != null) return null;
    const { replyTarget, quotedPost } = note.post;
    return await getNote(ctx, note, {
      replyTargetId:
        replyTarget == null || isApTargetHidden(replyTarget)
          ? undefined
          : new URL(replyTarget.iri),
      quotedPost: isApTargetHidden(quotedPost)
        ? undefined
        : (quotedPost ?? undefined),
      quoteAuthorizationIri: note.post.quoteAuthorizationIri,
      quoteRequestPolicy: note.post.quoteRequestPolicy,
    });
  })
  .authorize(async (ctx, values) => {
    if (!validateUuid(values.id)) return false;
    const post = await ctx.data.db.query.postTable.findFirst({
      with: {
        actor: {
          with: {
            followers: {
              with: { follower: true },
            },
            blockees: {
              with: { blockee: true },
            },
            blockers: {
              with: { blocker: true },
            },
          },
        },
        mentions: {
          with: { actor: true },
        },
      },
      where: { noteSourceId: values.id, type: "Note" },
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

builder
  .setObjectDispatcher(
    vocab.Question,
    "/ap/questions/{id}",
    async (ctx, values) => {
      if (!validateUuid(values.id)) return null;
      const note = await ctx.data.db.query.noteSourceTable.findFirst({
        with: {
          account: true,
          media: { with: { medium: true }, orderBy: { index: "asc" } },
        },
        where: { id: values.id },
      });
      if (note == null) return null;
      const post = await ctx.data.db.query.postTable.findFirst({
        with: {
          replyTarget: { with: { actor: true } },
          quotedPost: { with: { actor: true } },
          poll: {
            with: {
              options: { orderBy: { index: "asc" } },
            },
          },
        },
        where: { noteSourceId: values.id, type: "Question" },
      });
      if (post?.poll == null) return null;
      // Censored content is not served over ActivityPub.
      if (post.censored != null) return null;
      const { replyTarget, quotedPost } = post;
      return await getQuestion(
        ctx,
        note,
        { ...post.poll, post },
        {
          replyTargetId:
            replyTarget == null || isApTargetHidden(replyTarget)
              ? undefined
              : new URL(replyTarget.iri),
          quotedPost: isApTargetHidden(quotedPost)
            ? undefined
            : (quotedPost ?? undefined),
          quoteAuthorizationIri: post.quoteAuthorizationIri,
          quoteRequestPolicy: post.quoteRequestPolicy,
        },
      );
    },
  )
  .authorize(async (ctx, values) => {
    if (!validateUuid(values.id)) return false;
    const post = await ctx.data.db.query.postTable.findFirst({
      with: {
        actor: {
          with: {
            followers: {
              with: { follower: true },
            },
            blockees: {
              with: { blockee: true },
            },
            blockers: {
              with: { blocker: true },
            },
          },
        },
        mentions: {
          with: { actor: true },
        },
      },
      where: { noteSourceId: values.id, type: "Question" },
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

builder
  .setObjectDispatcher(
    vocab.QuoteAuthorization,
    "/ap/quote-authorizations/{id}",
    async (ctx, values) => {
      if (!validateUuid(values.id)) return null;
      const authorization =
        await ctx.data.db.query.quoteAuthorizationTable.findFirst({
          with: {
            quotedPost: { with: { actor: true } },
          },
          where: {
            id: values.id,
            revoked: false,
          },
        });
      if (authorization == null) return null;
      // Stop serving an authorization once its quoted post is censored:
      // isPostVisibleTo (used by authorize) deliberately ignores `censored`
      // for permalinks, so without this a remote instance could keep
      // validating an already-issued quote of moderation-hidden content.
      // Reversible by design: lifting the censorship serves it again.
      if (authorization.quotedPost.censored != null) return null;
      return new vocab.QuoteAuthorization({
        id: new URL(authorization.iri),
        attribution: new URL(authorization.quotedPost.actor.iri),
        interactingObject: new URL(authorization.quotePostIri),
        interactionTarget: new URL(authorization.quotedPost.iri),
      });
    },
  )
  .authorize(async (ctx, values) => {
    if (!validateUuid(values.id)) return false;
    const authorization =
      await ctx.data.db.query.quoteAuthorizationTable.findFirst({
        with: {
          quotedPost: {
            with: {
              actor: {
                with: {
                  followers: { with: { follower: true } },
                  blockees: { with: { blockee: true } },
                  blockers: { with: { blocker: true } },
                },
              },
              mentions: { with: { actor: true } },
            },
          },
        },
        where: {
          id: values.id,
          revoked: false,
        },
      });
    if (authorization == null) return false;
    // A censored quoted post makes the authorization unavailable (checked
    // before any key/document-loader work); isPostVisibleTo below ignores
    // `censored`, so this is what actually gates the moderation-hidden case.
    if (authorization.quotedPost.censored != null) return false;
    const documentLoader = await ctx.getDocumentLoader({
      identifier: authorization.quotedPost.actor.accountId ?? values.id,
    });
    const signedKeyOwner = await ctx.getSignedKeyOwner({ documentLoader });
    return isPostVisibleTo(
      authorization.quotedPost,
      signedKeyOwner?.id == null ? undefined : { iri: signedKeyOwner.id.href },
    );
  });

export function getAnnounce(
  ctx: Context<ContextData>,
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

export function getCreate(
  ctx: Context<ContextData>,
  post: Post & {
    actor: Actor & { account: Account };
    mentions: (Mention & { actor: Actor })[];
  },
): vocab.Create {
  return new vocab.Create({
    id: ctx.getObjectUri(vocab.Create, { id: post.id }),
    actor: ctx.getActorUri(post.actor.account.id),
    ...getPostRecipients(
      ctx,
      post.actor.account.id,
      post.mentions.map((m) => new URL(m.actor.iri)),
      post.visibility,
    ),
    object: new URL(post.iri),
    published: post.published.toTemporalInstant(),
  });
}

builder.setObjectDispatcher(
  vocab.Announce,
  "/ap/announces/{id}",
  async (ctx, values) => {
    if (!validateUuid(values.id)) return null;
    const share = await ctx.data.db.query.postTable.findFirst({
      with: {
        actor: { with: { account: true } },
        sharedPost: { with: { actor: true } },
        mentions: { with: { actor: true } },
      },
      where: {
        id: values.id,
        sharedPostId: { isNotNull: true },
      },
    });
    if (
      share == null ||
      share.actor.account == null ||
      share.sharedPost == null
    ) {
      return null;
    }
    // Neither a censored boost nor a boost of a censored post is served
    // over ActivityPub.
    if (share.censored != null || share.sharedPost.censored != null) {
      return null;
    }
    // The same goes when the booster or the boosted post's author is
    // hidden by a moderation sanction (ban / federation block).
    if (
      isActorSanctionHidden(share.actor) ||
      isActorSanctionHidden(share.sharedPost.actor)
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

builder
  .setObjectDispatcher(
    vocab.Create,
    "/ap/creates/{id}",
    async (ctx, values) => {
      if (!validateUuid(values.id)) return null;
      const post = await ctx.data.db.query.postTable.findFirst({
        with: {
          actor: { with: { account: true } },
          mentions: { with: { actor: true } },
        },
        where: {
          id: values.id,
          sharedPostId: { isNull: true },
        },
      });
      if (post == null || post.actor.account == null) return null;
      // Censored content is not served over ActivityPub.
      if (post.censored != null) return null;
      return getCreate(ctx, {
        ...post,
        actor: { ...post.actor, account: post.actor.account },
      });
    },
  )
  .authorize(async (ctx, values) => {
    if (!validateUuid(values.id)) return false;
    const post = await ctx.data.db.query.postTable.findFirst({
      with: {
        actor: {
          with: {
            followers: {
              with: { follower: true },
            },
            blockees: {
              with: { blockee: true },
            },
            blockers: {
              with: { blocker: true },
            },
          },
        },
        mentions: {
          with: { actor: true },
        },
      },
      where: {
        id: values.id,
        sharedPostId: { isNull: true },
      },
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

function getEmojiReactType(
  emoji: ReactionEmoji,
): typeof vocab.Like | typeof vocab.EmojiReact {
  return emoji === DEFAULT_REACTION_EMOJI ? vocab.Like : vocab.EmojiReact;
}

export function getEmojiReactId(
  ctx: Context<ContextData>,
  accountId: Uuid,
  postId: Uuid,
  emoji: ReactionEmoji,
): URL {
  return getEmojiReactType(emoji) === vocab.Like
    ? ctx.getObjectUri(vocab.Like, { accountId, postId, emoji })
    : ctx.getObjectUri(vocab.EmojiReact, {
        id: `${accountId}/${postId}/${emoji}`,
      });
}

export function getEmojiReact(
  ctx: Context<ContextData>,
  reaction: Reaction & {
    actor: Actor;
    customEmoji?: CustomEmoji | null;
    post: Post & { actor: Actor };
  },
): vocab.Like | vocab.EmojiReact | null {
  const content = reaction.emoji ?? reaction.customEmoji?.name;
  if (content == null) return null;
  const activityType =
    reaction.customEmoji == null &&
    reaction.emoji != null &&
    isReactionEmoji(reaction.emoji)
      ? getEmojiReactType(reaction.emoji)
      : vocab.EmojiReact;
  let id: URL;
  try {
    id = new URL(reaction.iri);
  } catch {
    return null;
  }
  const actor =
    reaction.actor.accountId == null
      ? new URL(reaction.actor.iri)
      : ctx.getActorUri(reaction.actor.accountId);
  return new activityType({
    id,
    actor,
    tos: [
      new URL(reaction.post.actor.iri),
      ...(reaction.actor.accountId == null
        ? []
        : [ctx.getFollowersUri(reaction.actor.accountId)]),
    ],
    cc: PUBLIC_COLLECTION,
    object: new URL(reaction.post.iri),
    content,
    tags:
      reaction.customEmoji == null
        ? []
        : [
            new vocab.Emoji({
              id: new URL(reaction.customEmoji.iri),
              name: reaction.customEmoji.name,
              icon: new vocab.Image({
                mediaType: reaction.customEmoji.imageType,
                url: new URL(reaction.customEmoji.imageUrl),
              }),
            }),
          ],
  });
}

async function getEmojiReactOrLike(
  ctx: RequestContext<ContextData>,
  values: Record<"accountId" | "postId" | "emoji", string>,
): Promise<vocab.Like | vocab.EmojiReact | null> {
  return getStandardEmojiReactOrLike(
    ctx,
    values.accountId,
    values.postId,
    values.emoji,
  );
}

async function getStandardEmojiReactOrLike(
  ctx: RequestContext<ContextData>,
  accountId: string,
  postId: string,
  emoji: string,
): Promise<vocab.Like | vocab.EmojiReact | null> {
  if (
    !validateUuid(accountId) ||
    !validateUuid(postId) ||
    !isReactionEmoji(emoji)
  ) {
    return null;
  }
  const reaction = await ctx.data.db.query.reactionTable.findFirst({
    with: { actor: true, customEmoji: true, post: { with: { actor: true } } },
    where: {
      actor: { accountId },
      postId,
      emoji,
    },
  });
  if (reaction == null) return null;
  return getEmojiReact(ctx, reaction);
}

async function getCustomEmojiReact(
  ctx: RequestContext<ContextData>,
  values: Record<"id", string>,
): Promise<vocab.EmojiReact | null> {
  if (!validateUuid(values.id)) return null;
  const iri = new URL(
    `/ap/emojireacts/custom/${values.id}`,
    ctx.canonicalOrigin,
  ).href;
  const reaction = await ctx.data.db.query.reactionTable.findFirst({
    with: {
      actor: true,
      customEmoji: true,
      post: {
        with: {
          actor: {
            with: {
              followers: { with: { follower: true } },
              blockees: { with: { blockee: true } },
              blockers: { with: { blocker: true } },
            },
          },
          mentions: { with: { actor: true } },
        },
      },
    },
    where: {
      iri,
      customEmojiId: { isNotNull: true },
    },
  });
  if (reaction == null) return null;
  const kind = getEmojiReactionCollectionKindForPost(reaction.post);
  if (kind == null) return null;
  if (!(await canViewEmojiReactionPost(ctx, kind, reaction.post))) return null;
  const activity = getEmojiReact(ctx, reaction);
  return activity instanceof vocab.EmojiReact ? activity : null;
}

async function getEmojiReactByPath(
  ctx: RequestContext<ContextData>,
  values: Record<"id", string>,
): Promise<vocab.EmojiReact | null> {
  const segments = values.id.split("/");
  if (segments[0] === "custom" && segments.length === 2) {
    return getCustomEmojiReact(ctx, { id: segments[1] });
  }
  if (segments.length !== 3) return null;
  const [accountId, postId, emoji] = segments;
  const reaction = await getStandardEmojiReactOrLike(
    ctx,
    accountId,
    postId,
    decodeURIComponent(emoji),
  );
  return reaction instanceof vocab.EmojiReact ? reaction : null;
}

builder.setObjectDispatcher(
  vocab.Like,
  "/ap/likes/{accountId}/{postId}/{emoji}",
  getEmojiReactOrLike,
);

builder.setObjectDispatcher(
  vocab.EmojiReact,
  "/ap/emojireacts/{+id}",
  getEmojiReactByPath,
);

export type EmojiReactionCollectionKind = "article" | "note" | "question";

interface EmojiReactionCursor {
  readonly created: Date;
  readonly iri: string;
}

function getEmojiReactionObject(kind: EmojiReactionCollectionKind) {
  switch (kind) {
    case "article":
      return "articles";
    case "note":
      return "notes";
    case "question":
      return "questions";
  }
}

function parseEmojiReactionObject(
  object: string,
): EmojiReactionCollectionKind | null {
  switch (object) {
    case "articles":
      return "article";
    case "notes":
      return "note";
    case "questions":
      return "question";
    default:
      return null;
  }
}

export function isEmojiReactionCollectionVisible(
  kind: EmojiReactionCollectionKind,
  post: Parameters<typeof isPostVisibleTo>[0],
  signedActor?: { iri: string },
): boolean {
  return kind === "article" ? true : isPostVisibleTo(post, signedActor);
}

function getEmojiReactionCollectionKindForPost(
  post: Pick<Post, "type">,
): EmojiReactionCollectionKind | null {
  switch (post.type) {
    case "Article":
      return "article";
    case "Note":
      return "note";
    case "Question":
      return "question";
    default:
      return null;
  }
}

function hasHttpSignature(ctx: RequestContext<ContextData>): boolean {
  const request = (ctx as RequestContext<ContextData> & { request?: Request })
    .request;
  if (request == null) return false;
  return (
    request.headers.has("authorization") ||
    request.headers.has("signature") ||
    request.headers.has("signature-input")
  );
}

async function canViewEmojiReactionPost(
  ctx: RequestContext<ContextData>,
  kind: EmojiReactionCollectionKind,
  post: Parameters<typeof isPostVisibleTo>[0] & {
    actor: { accountId?: Uuid | null };
    censored?: Date | null;
  },
): Promise<boolean> {
  if (post.censored != null) return false;
  if (kind === "article" && isActorSanctionHidden(post.actor)) return false;
  if (kind === "article") return isEmojiReactionCollectionVisible(kind, post);
  let signedActor: { iri: string } | undefined;
  if (hasHttpSignature(ctx)) {
    if (post.actor.accountId == null) return false;
    const documentLoader = await ctx.getDocumentLoader({
      identifier: post.actor.accountId,
    });
    const signedKeyOwner = await ctx.getSignedKeyOwner({ documentLoader });
    signedActor =
      signedKeyOwner?.id == null ? undefined : { iri: signedKeyOwner.id.href };
  }
  return isEmojiReactionCollectionVisible(kind, post, signedActor);
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): string | null {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    return new TextDecoder().decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function encodeEmojiReactionCursor(
  reaction: Pick<Reaction, "created" | "iri">,
): string {
  return encodeBase64Url(
    JSON.stringify({
      created: reaction.created.toISOString(),
      iri: reaction.iri,
    }),
  );
}

function decodeEmojiReactionCursor(cursor: string): EmojiReactionCursor | null {
  const json = decodeBase64Url(cursor);
  if (json == null) return null;
  try {
    const parsed = JSON.parse(json) as { created?: unknown; iri?: unknown };
    if (typeof parsed.created !== "string" || typeof parsed.iri !== "string") {
      return null;
    }
    const created = new Date(parsed.created);
    if (Number.isNaN(created.valueOf())) return null;
    return { created, iri: parsed.iri };
  } catch {
    return null;
  }
}

type ReplyCollectionKind = "article" | "note" | "question";

interface RepliesCursor {
  readonly published: Date;
  readonly id: Uuid;
}

function getReplyCollectionObject(
  kind: ReplyCollectionKind,
): ReplyCollectionObject {
  switch (kind) {
    case "article":
      return "articles";
    case "note":
      return "notes";
    case "question":
      return "questions";
  }
}

function parseReplyCollectionObject(
  object: string,
): ReplyCollectionKind | null {
  switch (object) {
    case "articles":
      return "article";
    case "notes":
      return "note";
    case "questions":
      return "question";
    default:
      return null;
  }
}

function encodeRepliesCursor(post: Pick<Post, "id" | "published">): string {
  return encodeBase64Url(
    JSON.stringify({
      id: post.id,
      published: post.published.toISOString(),
    }),
  );
}

function decodeRepliesCursor(cursor: string): RepliesCursor | null {
  const json = decodeBase64Url(cursor);
  if (json == null) return null;
  try {
    const parsed = JSON.parse(json) as { id?: unknown; published?: unknown };
    if (
      typeof parsed.id !== "string" ||
      !validateUuid(parsed.id) ||
      typeof parsed.published !== "string"
    ) {
      return null;
    }
    const published = new Date(parsed.published);
    if (Number.isNaN(published.valueOf())) return null;
    return { id: parsed.id, published };
  } catch {
    return null;
  }
}

async function getPostForReplies(
  ctx: RequestContext<ContextData>,
  kind: ReplyCollectionKind,
  id: Uuid,
) {
  const post = await ctx.data.db.query.postTable.findFirst({
    with: { actor: true },
    where:
      kind === "article"
        ? { articleSourceId: id, type: "Article" }
        : kind === "note"
          ? { noteSourceId: id, type: "Note" }
          : { noteSourceId: id, type: "Question" },
  });
  if (
    post == null ||
    post.censored != null ||
    !isPublicPostVisibility(post.visibility) ||
    isActorSanctionHidden(post.actor)
  ) {
    return null;
  }
  return post;
}

async function getRepliesCollectionRows(
  ctx: RequestContext<ContextData>,
  postId: Uuid,
  cursor: string | null,
): Promise<{
  rows: Pick<Post, "id" | "iri" | "published">[];
  nextCursor: string | null;
} | null> {
  const decodedCursor =
    cursor == null || cursor.trim() === "" ? null : decodeRepliesCursor(cursor);
  if (cursor != null && cursor.trim() !== "" && decodedCursor == null) {
    return null;
  }
  const rows = await ctx.data.db.query.postTable.findMany({
    columns: { id: true, iri: true, published: true },
    where: {
      AND: [
        { replyTargetId: postId },
        { actor: getSanctionVisibleActorFilter() },
        getCensoredPostExclusionFilter(null),
        getPostVisibilityFilter(null),
        ...(decodedCursor == null
          ? []
          : [
              {
                OR: [
                  { published: { lt: decodedCursor.published } },
                  {
                    published: { eq: decodedCursor.published },
                    id: { lt: decodedCursor.id },
                  },
                ],
              },
            ]),
      ],
    },
    orderBy: (post, { desc }) => [desc(post.published), desc(post.id)],
    limit: REPLIES_WINDOW + 1,
  });
  const pageRows = rows.slice(0, REPLIES_WINDOW);
  return {
    rows: pageRows,
    nextCursor:
      rows.length > REPLIES_WINDOW
        ? encodeRepliesCursor(pageRows[pageRows.length - 1])
        : null,
  };
}

async function countRepliesCollectionItems(
  ctx: RequestContext<ContextData>,
  postId: Uuid,
): Promise<number> {
  const sharedPost = aliasedTable(postTable, "replies_shared_post");
  const sharedActor = aliasedTable(actorTable, "replies_shared_actor");
  const now = new Date();
  const [{ cnt }] = await ctx.data.db
    .select({ cnt: count() })
    .from(postTable)
    .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
    .leftJoin(sharedPost, eq(sharedPost.id, postTable.sharedPostId))
    .leftJoin(sharedActor, eq(sharedActor.id, sharedPost.actorId))
    .where(
      and(
        eq(postTable.replyTargetId, postId),
        inArray(postTable.visibility, ["public", "unlisted"]),
        isNull(postTable.censored),
        or(
          isNull(actorTable.suspended),
          gt(actorTable.suspended, now),
          lte(actorTable.suspendedUntil, now),
          and(
            isNotNull(actorTable.accountId),
            gt(actorTable.suspendedUntil, now),
          ),
        ),
        or(isNull(sharedPost.id), isNull(sharedPost.censored)),
        or(
          isNull(sharedPost.id),
          isNull(sharedActor.suspended),
          gt(sharedActor.suspended, now),
          lte(sharedActor.suspendedUntil, now),
          and(
            isNotNull(sharedActor.accountId),
            gt(sharedActor.suspendedUntil, now),
          ),
        ),
      ),
    );
  return cnt;
}

builder
  // Use object dispatchers for now because Fedify 2.3.1 drops custom
  // collection dispatcher callbacks during `FederationBuilder.build()`.
  // See https://github.com/fedify-dev/fedify/issues/849.
  .setObjectDispatcher(
    vocab.OrderedCollection,
    "/ap/replies/{object}/{id}",
    async (ctx, values) => {
      const kind = parseReplyCollectionObject(values.object);
      if (kind == null || !validateUuid(values.id)) return null;
      const post = await getPostForReplies(ctx, kind, values.id);
      if (post == null) return null;
      const object = getReplyCollectionObject(kind);
      return new vocab.OrderedCollection({
        id: getRepliesUri(ctx, object, values.id),
        totalItems: await countRepliesCollectionItems(ctx, post.id),
        first: getRepliesPageUri(ctx, object, values.id, "_"),
      });
    },
  )
  .authorize(async (ctx, values) => {
    const kind = parseReplyCollectionObject(values.object);
    return (
      kind != null &&
      validateUuid(values.id) &&
      (await getPostForReplies(ctx, kind, values.id)) != null
    );
  });

builder
  .setObjectDispatcher(
    vocab.OrderedCollectionPage,
    "/ap/replies/{object}/{id}/page/{cursor}",
    async (ctx, values) => {
      const kind = parseReplyCollectionObject(values.object);
      if (kind == null || !validateUuid(values.id)) return null;
      const post = await getPostForReplies(ctx, kind, values.id);
      if (post == null) return null;
      const object = getReplyCollectionObject(kind);
      const cursor = values.cursor === "_" ? "" : values.cursor;
      const page = await getRepliesCollectionRows(ctx, post.id, cursor);
      if (page == null) return null;
      return new vocab.OrderedCollectionPage({
        id: getRepliesPageUri(ctx, object, values.id, values.cursor),
        partOf: getRepliesUri(ctx, object, values.id),
        items: page.rows.map((row) => new URL(row.iri)),
        next:
          page.nextCursor == null
            ? null
            : getRepliesPageUri(ctx, object, values.id, page.nextCursor),
      });
    },
  )
  .authorize(async (ctx, values) => {
    const kind = parseReplyCollectionObject(values.object);
    return (
      kind != null &&
      validateUuid(values.id) &&
      (await getPostForReplies(ctx, kind, values.id)) != null
    );
  });

async function getPostForEmojiReactions(
  ctx: RequestContext<ContextData>,
  kind: EmojiReactionCollectionKind,
  id: Uuid,
) {
  const post = await ctx.data.db.query.postTable.findFirst({
    with: {
      actor: {
        with: {
          followers: { with: { follower: true } },
          blockees: { with: { blockee: true } },
          blockers: { with: { blocker: true } },
        },
      },
      mentions: { with: { actor: true } },
    },
    where:
      kind === "article"
        ? { articleSourceId: id, type: "Article" }
        : kind === "note"
          ? { noteSourceId: id, type: "Note" }
          : { noteSourceId: id, type: "Question" },
  });
  if (post == null || post.censored != null) return null;
  if (kind === "article" && isActorSanctionHidden(post.actor)) return null;
  return post;
}

async function canViewEmojiReactions(
  ctx: RequestContext<ContextData>,
  kind: EmojiReactionCollectionKind,
  id: Uuid,
): Promise<boolean> {
  const post = await getPostForEmojiReactions(ctx, kind, id);
  if (post == null) return false;
  return await canViewEmojiReactionPost(ctx, kind, post);
}

async function getEmojiReactionCollectionItems(
  ctx: RequestContext<ContextData>,
  kind: EmojiReactionCollectionKind,
  id: Uuid,
  cursor: string | null,
): Promise<{
  items: (vocab.Like | vocab.EmojiReact)[];
  nextCursor: string | null;
} | null> {
  const post = await getPostForEmojiReactions(ctx, kind, id);
  if (post == null) return null;
  const decodedCursor =
    cursor == null || cursor.trim() === ""
      ? null
      : decodeEmojiReactionCursor(cursor);
  if (cursor != null && cursor.trim() !== "" && decodedCursor == null) {
    return null;
  }
  const rows = await ctx.data.db
    .select({
      iri: reactionTable.iri,
      created: reactionTable.created,
    })
    .from(reactionTable)
    .where(
      and(
        eq(reactionTable.postId, post.id),
        decodedCursor == null
          ? undefined
          : or(
              lt(reactionTable.created, decodedCursor.created),
              and(
                eq(reactionTable.created, decodedCursor.created),
                lt(reactionTable.iri, decodedCursor.iri),
              ),
            ),
      ),
    )
    .orderBy(desc(reactionTable.created), desc(reactionTable.iri))
    .limit(EMOJI_REACTIONS_WINDOW + 1);
  const pageRows = rows.slice(0, EMOJI_REACTIONS_WINDOW);
  if (pageRows.length < 1) return { items: [], nextCursor: null };
  const reactions = await ctx.data.db.query.reactionTable.findMany({
    with: {
      actor: true,
      customEmoji: true,
      post: { with: { actor: true } },
    },
    where: { iri: { in: pageRows.map((row) => row.iri) } },
  });
  const reactionByIri = new Map(
    reactions.map((reaction) => [reaction.iri, reaction]),
  );
  const items = pageRows
    .map((row) => reactionByIri.get(row.iri))
    .map((reaction) => (reaction == null ? null : getEmojiReact(ctx, reaction)))
    .filter((item): item is vocab.Like | vocab.EmojiReact => item != null);
  return {
    items,
    nextCursor:
      rows.length > EMOJI_REACTIONS_WINDOW
        ? encodeEmojiReactionCursor(pageRows[pageRows.length - 1])
        : null,
  };
}

builder
  // Use object dispatchers for now because Fedify 2.3.1 drops custom
  // collection dispatcher callbacks during `FederationBuilder.build()`.
  // See https://github.com/fedify-dev/fedify/issues/849.
  .setObjectDispatcher(
    vocab.Collection,
    "/ap/emoji-reactions/{object}/{id}",
    async (ctx, values) => {
      const kind = parseEmojiReactionObject(values.object);
      if (kind == null || !validateUuid(values.id)) return null;
      if (!(await canViewEmojiReactions(ctx, kind, values.id))) return null;
      const post = await getPostForEmojiReactions(ctx, kind, values.id);
      if (post == null) return null;
      const [{ cnt }] = await ctx.data.db
        .select({ cnt: count() })
        .from(reactionTable)
        .where(eq(reactionTable.postId, post.id));
      const object = getEmojiReactionObject(kind);
      return new vocab.Collection({
        id: getEmojiReactionsUri(ctx, object, values.id),
        totalItems: cnt,
        first: getEmojiReactionsPageUri(ctx, object, values.id, "_"),
      });
    },
  )
  .authorize(async (ctx, values) => {
    const kind = parseEmojiReactionObject(values.object);
    return (
      kind != null &&
      validateUuid(values.id) &&
      (await canViewEmojiReactions(ctx, kind, values.id))
    );
  });

builder
  .setObjectDispatcher(
    vocab.CollectionPage,
    "/ap/emoji-reactions/{object}/{id}/page/{cursor}",
    async (ctx, values) => {
      const kind = parseEmojiReactionObject(values.object);
      if (kind == null || !validateUuid(values.id)) return null;
      if (!(await canViewEmojiReactions(ctx, kind, values.id))) return null;
      const object = getEmojiReactionObject(kind);
      const cursor = values.cursor === "_" ? "" : values.cursor;
      const page = await getEmojiReactionCollectionItems(
        ctx,
        kind,
        values.id,
        cursor,
      );
      if (page == null) return null;
      return new vocab.CollectionPage({
        id: getEmojiReactionsPageUri(ctx, object, values.id, values.cursor),
        partOf: getEmojiReactionsUri(ctx, object, values.id),
        items: page.items,
        next:
          page.nextCursor == null
            ? null
            : getEmojiReactionsPageUri(ctx, object, values.id, page.nextCursor),
      });
    },
  )
  .authorize(async (ctx, values) => {
    const kind = parseEmojiReactionObject(values.object);
    return (
      kind != null &&
      validateUuid(values.id) &&
      (await canViewEmojiReactions(ctx, kind, values.id))
    );
  });
