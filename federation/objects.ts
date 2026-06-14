import type { Context, RequestContext } from "@fedify/fedify";
import { LanguageString, PUBLIC_COLLECTION } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import {
  DEFAULT_REACTION_EMOJI,
  isReactionEmoji,
  type ReactionEmoji,
} from "@hackerspub/models/emoji";
import {
  getMissingArticleMediumLabel,
  renderMarkup,
  resolveMediumUrls,
} from "@hackerspub/models/markup";
import {
  isActorSanctionHidden,
  isPostVisibleTo,
  normalizeQuotePolicyForVisibility,
} from "@hackerspub/models/post";
import type {
  Account,
  Actor,
  ArticleContent,
  ArticleSource,
  Medium,
  Mention,
  NoteSource,
  NoteSourceMedium,
  Poll,
  PollOption,
  Post,
  PostVisibility,
  QuotePolicy,
  Reaction,
} from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { escape } from "@std/html/entities";
import { builder } from "./builder.ts";

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
    `/@${articleSource.account.username}/${articleSource.publishedYear}/${
      encodeURIComponent(articleSource.slug)
    }`,
    ctx.canonicalOrigin,
  );
  const contents = await Promise.all(
    articleSource.contents.map(async (content) => {
      const missingMediumLabel = getMissingArticleMediumLabel(
        content.language,
      );
      const rendered = await renderMarkup(ctx, content.content, {
        docId: articleSource.id,
        kv: ctx.data.kv,
        mediumUrls,
        missingMediumLabel,
      });
      return {
        ...content,
        ...rendered,
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
        new Intl.DisplayNames(c.language, { type: "language" })
          .of(c.language) ?? "";
      const langName = displayNames.of(c.language) ?? "";
      content += `<li lang="${escape(c.language)}">${escape(nativeLangName)} (${
        escape(langName)
      }): <a hreflang="${escape(c.language)}" href="${escape(url.href)}/${
        escape(encodeURIComponent(c.language))
      }">${escape(c.title)}</a></li>\n`;
    }
    content += `</ul></nav>\n<hr>\n${contents[0].html}`;
  } else if (contents.length > 0) {
    content = contents[0].html;
  }
  return new vocab.Article({
    id: ctx.getObjectUri(vocab.Article, { id: articleSource.id }),
    attribution: ctx.getActorUri(articleSource.accountId),
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
    source: contents.length > 0
      ? new vocab.Source({
        content: contents[0].content,
        mediaType: "text/markdown",
      })
      : null,
    tags: [...articleSource.tags, ...hashtags].map((tag) =>
      new vocab.Hashtag({
        name: `#${tag.replace(/^#/, "")}`,
        href: new URL(
          `/tags/${encodeURIComponent(tag.replace(/^#/, ""))}`,
          ctx.canonicalOrigin,
        ),
      })
    ),
    url,
    published: articleSource.published.toTemporalInstant(),
    updated: +articleSource.updated > +articleSource.published
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
  const automaticApproval = quotePolicy === "everyone"
    ? PUBLIC_COLLECTION
    : quotePolicy === "followers"
    ? ctx.getFollowersUri(accountId)
    : ctx.getActorUri(accountId);
  const manualApproval = quoteRequestPolicy == null
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
    ccs: visibility === "public"
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
  const rendered = await renderMarkup(ctx, note.content, {
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
  const tags: vocab.Link[] = Object.entries(rendered.mentions)
    .map(([handle, actor]) =>
      new vocab.Mention({
        href: new URL(actor.iri),
        name: handle,
      })
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
  const normalizedQuotePolicy = normalizeQuotePolicyForVisibility(
    note.visibility,
    note.quotePolicy,
  );
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
    interactionPolicy: note.visibility === "direct" ||
        note.visibility === "none"
      ? undefined
      : getQuoteInteractionPolicy(
        ctx,
        note.accountId,
        normalizedQuotePolicy,
        relations.quoteRequestPolicy,
      ),
    quote: relations.quotedPost == null
      ? null
      : new URL(relations.quotedPost.iri),
    quoteUrl: relations.quotedPost == null
      ? null
      : new URL(relations.quotedPost.iri),
    quoteAuthorization: relations.quoteAuthorizationIri == null
      ? null
      : new URL(relations.quoteAuthorizationIri),
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
  const rendered = await renderMarkup(ctx, note.content, {
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
  const tags: vocab.Link[] = Object.entries(rendered.mentions)
    .map(([handle, actor]) =>
      new vocab.Mention({
        href: new URL(actor.iri),
        name: handle,
      })
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
  const normalizedQuotePolicy = normalizeQuotePolicyForVisibility(
    note.visibility,
    note.quotePolicy,
  );
  const options = poll.options
    .toSorted((a, b) => a.index - b.index)
    .map((option) =>
      new vocab.Note({
        name: option.title,
        replies: new vocab.Collection({
          totalItems: option.votesCount,
        }),
      })
    );
  return new vocab.Question({
    id: ctx.getObjectUri(vocab.Question, { id: note.id }),
    attribution: ctx.getActorUri(note.accountId),
    ...getPostRecipients(
      ctx,
      note.accountId,
      Object.values(rendered.mentions).map((actor) => new URL(actor.iri)),
      note.visibility,
    ),
    replyTarget: relations.replyTargetId,
    interactionPolicy: note.visibility === "direct" ||
        note.visibility === "none"
      ? undefined
      : getQuoteInteractionPolicy(
        ctx,
        note.accountId,
        normalizedQuotePolicy,
        relations.quoteRequestPolicy,
      ),
    quote: relations.quotedPost == null
      ? null
      : new URL(relations.quotedPost.iri),
    quoteUrl: relations.quotedPost == null
      ? null
      : new URL(relations.quotedPost.iri),
    quoteAuthorization: relations.quoteAuthorizationIri == null
      ? null
      : new URL(relations.quoteAuthorizationIri),
    name: poll.post.name,
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
    endTime: poll.ends.toTemporalInstant(),
    voters: poll.votersCount,
    ...(poll.multiple
      ? { inclusiveOptions: options }
      : { exclusiveOptions: options }),
    published: note.published.toTemporalInstant(),
    updated: +note.updated > +note.published
      ? note.updated.toTemporalInstant()
      : null,
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
  return target != null &&
    (target.censored != null || isActorSanctionHidden(target.actor));
}

builder
  .setObjectDispatcher(
    vocab.Note,
    "/ap/notes/{id}",
    async (ctx, values) => {
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
      return await getNote(
        ctx,
        note,
        {
          replyTargetId: replyTarget == null || isApTargetHidden(replyTarget)
            ? undefined
            : new URL(replyTarget.iri),
          quotedPost: isApTargetHidden(quotedPost)
            ? undefined
            : quotedPost ?? undefined,
          quoteAuthorizationIri: note.post.quoteAuthorizationIri,
          quoteRequestPolicy: note.post.quoteRequestPolicy,
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
          replyTargetId: replyTarget == null || isApTargetHidden(replyTarget)
            ? undefined
            : new URL(replyTarget.iri),
          quotedPost: isApTargetHidden(quotedPost)
            ? undefined
            : quotedPost ?? undefined,
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
      const authorization = await ctx.data.db.query.quoteAuthorizationTable
        .findFirst({
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
    const authorization = await ctx.data.db.query.quoteAuthorizationTable
      .findFirst({
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
      share == null || share.actor.account == null || share.sharedPost == null
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
  const activityType = getEmojiReactType(emoji);
  return ctx.getObjectUri<vocab.Like | vocab.EmojiReact>(activityType, {
    accountId,
    postId,
    emoji,
  });
}

export function getEmojiReact(
  ctx: Context<ContextData>,
  reaction: Reaction & { actor: Actor; post: Post & { actor: Actor } },
): vocab.Like | vocab.EmojiReact | null {
  if (
    reaction.actor.accountId == null || reaction.emoji == null ||
    !isReactionEmoji(reaction.emoji)
  ) {
    return null;
  }
  const activityType = getEmojiReactType(reaction.emoji);
  return new activityType({
    id: getEmojiReactId(
      ctx,
      reaction.actor.accountId,
      reaction.post.id,
      reaction.emoji,
    ),
    actor: ctx.getActorUri(reaction.actor.accountId),
    tos: [
      new URL(reaction.post.actor.iri),
      ctx.getFollowersUri(reaction.actor.accountId),
    ],
    cc: PUBLIC_COLLECTION,
    object: new URL(reaction.post.iri),
    content: reaction.emoji,
  });
}

async function getEmojiReactOrLike(
  ctx: RequestContext<ContextData>,
  values: Record<"accountId" | "postId" | "emoji", string>,
): Promise<vocab.Like | vocab.EmojiReact | null> {
  if (
    !validateUuid(values.accountId) || !validateUuid(values.postId) ||
    !isReactionEmoji(values.emoji)
  ) {
    return null;
  }
  const reaction = await ctx.data.db.query.reactionTable.findFirst({
    with: { actor: true, post: { with: { actor: true } } },
    where: {
      actor: { accountId: values.accountId },
      postId: values.postId,
      emoji: values.emoji,
    },
  });
  if (reaction == null) return null;
  return getEmojiReact(ctx, reaction);
}

builder.setObjectDispatcher(
  vocab.Like,
  "/ap/likes/{accountId}/{postId}/{emoji}",
  getEmojiReactOrLike,
);

builder.setObjectDispatcher(
  vocab.EmojiReact,
  "/ap/emojireacts/{accountId}/{postId}/{emoji}",
  getEmojiReactOrLike,
);
