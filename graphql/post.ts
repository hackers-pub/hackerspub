import { generateAltText } from "@hackerspub/ai/alttext";
import { getLogger } from "@logtape/logtape";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { unreachable } from "@std/assert";
import { assertNever } from "@std/assert/unstable-never";
import { and, eq } from "drizzle-orm";
import { getAvatarUrl } from "@hackerspub/models/account";
import {
  createArticle,
  deleteArticleDraft,
  getArticleDraftMediumUrls,
  getArticleSourceMediumUrls,
  getOriginalArticleContent,
  LanguageChangeWithTranslationsError,
  startArticleContentTranslation,
  updateArticle,
  updateArticleDraft,
} from "@hackerspub/models/article";
import {
  arePostsBookmarkedBy,
  createBookmark,
  deleteBookmark,
} from "@hackerspub/models/bookmark";
import { isReactionEmoji, renderCustomEmojis } from "@hackerspub/models/emoji";
import { addExternalLinkTargets, stripHtml } from "@hackerspub/models/html";
import { negotiateLocale, normalizeLocale } from "@hackerspub/models/i18n";
import {
  getMissingArticleMediumLabel,
  renderMarkup,
} from "@hackerspub/models/markup";
import {
  createMediumFromBytes,
  createMediumFromUrl,
  MAX_STREAMING_MEDIUM_IMAGE_SIZE,
  SUPPORTED_MEDIUM_IMAGE_TYPES,
  UnsafeMediumUrlError,
} from "@hackerspub/models/medium";
import { createNote } from "@hackerspub/models/note";
import {
  arePostsPinnedBy,
  pinPost as pinPostModel,
  unpinPost as unpinPostModel,
} from "@hackerspub/models/pin";
import {
  arePostsSharedBy,
  deletePost,
  getPostVisibilityFilter,
  isPostVisibleTo,
  sharePost,
  unsharePost,
} from "@hackerspub/models/post";
import { react, undoReaction } from "@hackerspub/models/reaction";
import {
  articleContentTable,
  articleDraftMediumTable,
  articleDraftTable,
} from "@hackerspub/models/schema";
import type * as schema from "@hackerspub/models/schema";
import { withTransaction } from "@hackerspub/models/tx";
import { generateUuidV7, type Uuid } from "@hackerspub/models/uuid";
import {
  createMediumUploadSession,
  deleteMediumUploadSession,
  getMediumUploadSession,
  isMediumOwner,
  isMediumUploadWindowActive,
  MEDIUM_UPLOAD_TTL_MS,
  setMediumOwner,
} from "./medium-upload.ts";
import { Account } from "./account.ts";
import { Actor } from "./actor.ts";
import { builder, Node, type UserContext } from "./builder.ts";
import { InvalidInputError, NotAuthorizedError } from "./error.ts";
import { lookupPostByUrl, parseHttpUrl } from "./lookup.ts";
import { putArticleOgImage } from "./og.ts";
import { PostVisibility, toPostVisibility } from "./postvisibility.ts";
import { Reactable, Reaction } from "./reactable.ts";
import { NotAuthenticatedError } from "./session.ts";

const articleContentOgImageComplexity = 2_000;
const logger = getLogger(["hackerspub", "graphql", "post"]);

class SharedPostDeletionNotAllowedError extends Error {
  public constructor(public readonly inputPath: string) {
    super("Shared posts cannot be deleted. Use unsharePost instead.");
  }
}

type LlmTranslationNotAllowedReason = "DISABLED" | "SAME_LANGUAGE";

class LlmTranslationNotAllowedError extends Error {
  public constructor(public readonly reason: LlmTranslationNotAllowedReason) {
    super(`LLM translation not allowed: ${reason}`);
  }
}

export const PostType = builder.enumType("PostType", {
  values: ["ARTICLE", "NOTE", "QUESTION"],
});

const LlmTranslationNotAllowedReasonRef = builder.enumType(
  "LlmTranslationNotAllowedReason",
  {
    values: ["DISABLED", "SAME_LANGUAGE"] as const,
  },
);

builder.objectType(SharedPostDeletionNotAllowedError, {
  name: "SharedPostDeletionNotAllowedError",
  fields: (t) => ({
    inputPath: t.expose("inputPath", { type: "String" }),
  }),
});

builder.objectType(LlmTranslationNotAllowedError, {
  name: "LlmTranslationNotAllowedError",
  fields: (t) => ({
    reason: t.expose("reason", { type: LlmTranslationNotAllowedReasonRef }),
  }),
});

export const Post = builder.drizzleInterface("postTable", {
  variant: "Post",
  interfaces: [Reactable, Node],
  resolveType(post): string {
    switch (post.type) {
      case "Article":
        return Article.name;
      case "Note":
        return Note.name;
      case "Question":
        return Question.name;
      default:
        return assertNever(post.type);
    }
  },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    iri: t.field({
      type: "URL",
      select: {
        columns: { iri: true },
      },
      resolve: (post) => new URL(post.iri),
    }),
    visibility: t.field({
      type: PostVisibility,
      select: {
        columns: { visibility: true },
      },
      resolve(post) {
        return toPostVisibility(post.visibility);
      },
    }),
    name: t.exposeString("name", { nullable: true }),
    summary: t.exposeString("summary", { nullable: true }),
    content: t.field({
      type: "HTML",
      select: {
        columns: {
          contentHtml: true,
          emojis: true,
        },
      },
      resolve: (post, _, ctx) =>
        addExternalLinkTargets(
          renderCustomEmojis(post.contentHtml, post.emojis),
          new URL(ctx.fedCtx.canonicalOrigin),
        ),
    }),
    excerpt: t.string({
      select: {
        columns: {
          summary: true,
          contentHtml: true,
        },
      },
      resolve(post) {
        if (post.summary != null) return post.summary;
        return stripHtml(post.contentHtml);
      },
    }),
    language: t.exposeString("language", { nullable: true }),
    hashtags: t.field({
      type: [Hashtag],
      select: {
        columns: { tags: true },
      },
      resolve(post) {
        return Object.entries(post.tags).map(([name, href]) => ({
          name,
          href: new URL(href),
        }));
      },
    }),
    sensitive: t.exposeBoolean("sensitive"),
    engagementStats: t.variant(PostEngagementStats),
    url: t.field({
      type: "URL",
      nullable: true,
      select: {
        columns: { url: true },
      },
      resolve: (post) => post.url ? new URL(post.url) : null,
    }),
    updated: t.expose("updated", { type: "DateTime" }),
    published: t.expose("published", { type: "DateTime" }),
    actor: t.relation("actor"),
    media: t.relation("media"),
    link: t.relation("link", { type: PostLink, nullable: true }),
    viewerHasShared: t.loadable({
      type: "Boolean",
      // cache: false so a mutation that flips share state in the same
      // request (e.g., share + read viewerHasShared) re-queries instead
      // of returning the pre-mutation value.
      loaderOptions: { cache: false },
      load: async (postIds: Uuid[], ctx: UserContext): Promise<boolean[]> => {
        if (ctx.account == null) return postIds.map(() => false);
        const shared = await arePostsSharedBy(ctx.db, postIds, ctx.account);
        return postIds.map((id) => shared.has(id));
      },
      resolve: (post) => post.id,
    }),
    viewerHasBookmarked: t.loadable({
      type: "Boolean",
      loaderOptions: { cache: false },
      load: async (postIds: Uuid[], ctx: UserContext): Promise<boolean[]> => {
        if (ctx.account == null) return postIds.map(() => false);
        const bookmarked = await arePostsBookmarkedBy(
          ctx.db,
          postIds,
          ctx.account,
        );
        return postIds.map((id) => bookmarked.has(id));
      },
      resolve: (post) => post.id,
    }),
    viewerHasPinned: t.loadable({
      type: "Boolean",
      loaderOptions: { cache: false },
      load: async (postIds: Uuid[], ctx: UserContext): Promise<boolean[]> => {
        if (ctx.account == null) return postIds.map(() => false);
        const pinned = await arePostsPinnedBy(
          ctx.db,
          postIds,
          ctx.account.actor,
        );
        return postIds.map((id) => pinned.has(id));
      },
      resolve: (post) => post.id,
    }),
  }),
});

builder.drizzleInterfaceFields(Post, (t) => ({
  sharedPost: t.relation("sharedPost", { type: Post, nullable: true }),
  replyTarget: t.relation("replyTarget", { type: Post, nullable: true }),
  quotedPost: t.relation("quotedPost", { type: Post, nullable: true }),
  replies: t.relatedConnection("replies", { type: Post }),
  shares: t.relatedConnection("shares", { type: Post }),
  quotes: t.relatedConnection("quotes", { type: Post }),
  mentions: t.connection({
    type: Actor,
    select: (args, ctx, nestedSelection) => ({
      with: {
        mentions: mentionConnectionHelpers.getQuery(args, ctx, nestedSelection),
      },
    }),
    resolve: (post, args, ctx) =>
      mentionConnectionHelpers.resolve(post.mentions, args, ctx),
  }),
}));

export const Note = builder.drizzleNode("postTable", {
  variant: "Note",
  interfaces: [Post, Reactable],
  id: {
    column: (post) => post.id,
  },
});

export const Article = builder.drizzleNode("postTable", {
  variant: "Article",
  interfaces: [Post, Reactable],
  id: {
    column: (post) => post.id,
  },
  fields: (t) => ({
    // articleSource is only present for locally-authored articles. Articles
    // federated in from remote servers don't have one — the upstream
    // metadata lives on the post itself, not in our articleSource table —
    // so the fields below have to be nullable to represent that.
    publishedYear: t.int({
      nullable: true,
      select: {
        with: {
          articleSource: {
            columns: { publishedYear: true },
          },
        },
      },
      resolve: (post) => post.articleSource?.publishedYear ?? null,
    }),
    slug: t.string({
      nullable: true,
      select: {
        with: {
          articleSource: {
            columns: { slug: true },
          },
        },
      },
      resolve: (post) => post.articleSource?.slug ?? null,
    }),
    tags: t.stringList({
      nullable: true,
      select: {
        with: {
          articleSource: {
            columns: { tags: true },
          },
        },
      },
      resolve: (post) => post.articleSource?.tags ?? null,
    }),
    allowLlmTranslation: t.boolean({
      nullable: true,
      select: {
        with: {
          articleSource: {
            columns: { allowLlmTranslation: true },
          },
        },
      },
      resolve: (post) => post.articleSource?.allowLlmTranslation ?? null,
    }),
    contents: t.field({
      type: [ArticleContent],
      args: {
        language: t.arg({ type: "Locale", required: false }),
        includeBeingTranslated: t.arg({
          type: "Boolean",
          required: false,
          defaultValue: false,
        }),
      },
      complexity: (args) => ({
        field: 1,
        multiplier: args.language == null ? 10 : 1,
      }),
      select: (args) => ({
        with: {
          articleSource: {
            with: {
              contents: args.includeBeingTranslated
                ? {}
                : { where: { beingTranslated: false } },
            },
          },
        },
      }),
      resolve(post, args) {
        const contents = post.articleSource?.contents ?? [];
        if (args.language == null) return contents;
        const availableLocales = contents.map((c) => c.language);
        const selectedLocale = negotiateLocale(args.language, availableLocales);
        return contents.filter(
          (c) => c.language === selectedLocale?.baseName,
        );
      },
    }),
  }),
});

builder.drizzleObjectField(Article, "account", (t) =>
  t.field({
    // Federated remote articles don't carry an articleSource (see the
    // articleSource-backed fields on Article above), so the author has
    // to be nullable here too — for remote articles, callers should fall
    // back to the post-level actor.
    type: Account,
    nullable: true,
    select: (_, __, nestedSelection) => ({
      with: {
        articleSource: {
          with: {
            account: nestedSelection(),
          },
        },
      },
    }),
    resolve: (post) => post.articleSource?.account ?? null,
  }));

export const ArticleDraft = builder.drizzleNode("articleDraftTable", {
  variant: "ArticleDraft",
  id: {
    column: (draft) => draft.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    title: t.exposeString("title"),
    content: t.expose("content", { type: "Markdown" }),
    contentHtml: t.field({
      type: "HTML",
      description: "The rendered HTML of the draft's markdown content.",
      select: {
        columns: {
          content: true,
        },
      },
      async resolve(draft, _, ctx) {
        const rendered = await renderMarkup(ctx.fedCtx, draft.content, {
          mediumUrls: await getArticleDraftMediumUrls(
            ctx.db,
            ctx.disk,
            draft.id,
          ),
          missingMediumLabel: getMissingArticleMediumLabel(
            ctx.account?.locales?.[0],
          ),
        });
        return addExternalLinkTargets(
          rendered.html,
          new URL(ctx.fedCtx.canonicalOrigin),
        );
      },
    }),
    tags: t.exposeStringList("tags"),
    created: t.expose("created", { type: "DateTime" }),
    updated: t.expose("updated", { type: "DateTime" }),
    account: t.relation("account"),
  }),
});

export const Question = builder.drizzleNode("postTable", {
  variant: "Question",
  interfaces: [Post, Reactable],
  id: {
    column: (post) => post.id,
  },
});

export const ArticleContent = builder.drizzleNode("articleContentTable", {
  name: "ArticleContent",
  id: {
    column: (content) => [content.sourceId, content.language],
  },
  fields: (t) => ({
    language: t.expose("language", { type: "Locale" }),
    title: t.exposeString("title"),
    summary: t.exposeString("summary", { nullable: true }),
    summaryStarted: t.expose("summaryStarted", {
      type: "DateTime",
      nullable: true,
    }),
    content: t.field({
      type: "HTML",
      select: {
        columns: {
          content: true,
          language: true,
        },
        with: {
          source: {
            with: {
              post: {
                columns: {
                  emojis: true,
                },
              },
            },
          },
        },
      },
      async resolve(content, _, ctx) {
        const html = await renderMarkup(ctx.fedCtx, content.content, {
          kv: ctx.kv,
          mediumUrls: await getArticleSourceMediumUrls(
            ctx.db,
            ctx.disk,
            content.sourceId,
          ),
          missingMediumLabel: getMissingArticleMediumLabel(content.language),
        });
        return addExternalLinkTargets(
          renderCustomEmojis(html.html, content.source.post.emojis),
          new URL(ctx.fedCtx.canonicalOrigin),
        );
      },
    }),
    rawContent: t.field({
      type: "Markdown",
      description: "The raw markdown content for editing.",
      select: {
        columns: { content: true },
      },
      resolve(content) {
        return content.content;
      },
    }),
    toc: t.field({
      type: "JSON",
      description: "Table of contents for the article content.",
      select: {
        columns: { content: true, language: true, sourceId: true },
      },
      async resolve(content, _, ctx) {
        const rendered = await renderMarkup(ctx.fedCtx, content.content, {
          kv: ctx.kv,
          mediumUrls: await getArticleSourceMediumUrls(
            ctx.db,
            ctx.disk,
            content.sourceId,
          ),
          missingMediumLabel: getMissingArticleMediumLabel(content.language),
        });
        return rendered.toc;
      },
    }),
    originalLanguage: t.expose("originalLanguage", {
      type: "Locale",
      nullable: true,
    }),
    translator: t.relation("translator", { nullable: true }),
    translationRequester: t.relation("translationRequester", {
      nullable: true,
    }),
    beingTranslated: t.exposeBoolean("beingTranslated"),
    updated: t.expose("updated", { type: "DateTime" }),
    published: t.expose("published", { type: "DateTime" }),
    ogImageUrl: t.field({
      type: "URL",
      complexity: articleContentOgImageComplexity,
      select: {
        columns: {
          content: true,
          language: true,
          ogImageKey: true,
          sourceId: true,
          summary: true,
          title: true,
        },
        with: {
          source: {
            with: {
              account: {
                with: {
                  actor: {
                    columns: {
                      handleHost: true,
                    },
                  },
                  avatarMedium: true,
                  emails: true,
                },
              },
            },
          },
        },
      },
      async resolve(content, _, ctx) {
        const account = content.source.account;
        const rendered = await renderMarkup(ctx.fedCtx, content.content, {
          kv: ctx.kv,
          mediumUrls: await getArticleSourceMediumUrls(
            ctx.db,
            ctx.disk,
            content.sourceId,
          ),
          missingMediumLabel: getMissingArticleMediumLabel(content.language),
        });
        const avatarUrl = await getAvatarUrl(ctx.disk, account);
        const key = await putArticleOgImage(ctx.disk, content.ogImageKey, {
          authorName: account.name,
          avatarKey: account.avatarMedium?.key ?? avatarUrl,
          avatarUrl,
          excerpt: content.summary ?? rendered.text,
          handle: `@${account.username}@${account.actor.handleHost}`,
          language: content.language,
          sourceId: content.sourceId,
          title: content.title,
        });
        if (key !== content.ogImageKey) {
          await ctx.db.update(articleContentTable)
            .set({ ogImageKey: key })
            .where(
              and(
                eq(articleContentTable.sourceId, content.sourceId),
                eq(articleContentTable.language, content.language),
              ),
            );
        }
        return new URL(await ctx.disk.getUrl(key));
      },
    }),
    url: t.field({
      type: "URL",
      select: {
        with: {
          source: {
            columns: {
              publishedYear: true,
              slug: true,
            },
            with: {
              account: {
                columns: {
                  username: true,
                },
              },
              post: {
                columns: {
                  language: true,
                },
              },
            },
          },
        },
      },
      resolve(content, _, ctx) {
        if (
          content.originalLanguage != null ||
          content.language !== content.source.post.language
        ) {
          return new URL(
            `/@${content.source.account.username}/${content.source.publishedYear}/${content.source.slug}/${content.language}`,
            ctx.fedCtx.canonicalOrigin,
          );
        }
        return new URL(
          `/@${content.source.account.username}/${content.source.publishedYear}/${content.source.slug}`,
          ctx.fedCtx.canonicalOrigin,
        );
      },
    }),
  }),
});

const Hashtag = builder.simpleObject("Hashtag", {
  fields: (t) => ({
    name: t.string(),
    href: t.field({ type: "URL" }),
  }),
});

const PostEngagementStats = builder.drizzleObject("postTable", {
  variant: "PostEngagementStats",
  fields: (t) => ({
    replies: t.exposeInt("repliesCount"),
    shares: t.exposeInt("sharesCount"),
    quotes: t.exposeInt("quotesCount"),
    reactions: t.exposeInt("reactionsCount"),
  }),
});

builder.drizzleObjectField(PostEngagementStats, "post", (t) => t.variant(Post));

const mentionConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "mentionTable",
  {
    select: (nodeSelection) => ({
      with: {
        actor: nodeSelection(),
      },
    }),
    resolveNode: (mention) => mention.actor,
  },
);

builder.drizzleNode("postMediumTable", {
  name: "PostMedium",
  id: {
    column: (medium) => [medium.postId, medium.index],
  },
  fields: (t) => ({
    type: t.expose("type", { type: "MediaType" }),
    url: t.field({ type: "URL", resolve: (medium) => new URL(medium.url) }),
    alt: t.exposeString("alt", { nullable: true }),
    width: t.exposeInt("width", { nullable: true }),
    height: t.exposeInt("height", { nullable: true }),
    sensitive: t.exposeBoolean("sensitive"),
    thumbnailUrl: t.string({
      nullable: true,
      resolve(medium, _, ctx) {
        if (medium.thumbnailKey == null) return;
        return ctx.disk.getUrl(medium.thumbnailKey);
      },
    }),
  }),
});

export const Medium = builder.drizzleNode("mediumTable", {
  name: "Medium",
  id: {
    column: (medium) => medium.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    url: t.field({
      type: "URL",
      description: "Public URL for the stored medium.",
      resolve: async (medium, _, ctx) =>
        new URL(await ctx.disk.getUrl(medium.key)),
    }),
    type: t.expose("type", {
      type: "MediaType",
      description: "The medium's media type. Local uploads are stored as WebP.",
    }),
    contentHash: t.expose("contentHash", {
      type: "Sha256",
      nullable: true,
      description: "SHA-256 hash of the normalized stored content, if known.",
    }),
    width: t.exposeInt("width", { nullable: true }),
    height: t.exposeInt("height", { nullable: true }),
    created: t.expose("created", { type: "DateTime" }),
  }),
});

builder.drizzleObjectField(Medium, "generatedAltText", (t) =>
  t.string({
    nullable: true,
    description: "AI-generated alternative text for this medium. " +
      "Requires authentication. " +
      "Within the 2-hour upload window only the uploader may call this " +
      "field; after the window expires any authenticated user may call it " +
      "(the medium is either publicly referenced or pending orphan cleanup). " +
      "Multiple uploaders of identical content each get independent " +
      "ownership entries, so content-hash deduplication does not grant " +
      "the later uploader access to the earlier one's window. " +
      "High-complexity operation (cost 1000). " +
      "The context argument is truncated server-side to 1000 characters.",
    complexity: 1000,
    args: {
      language: t.arg({ type: "Locale", required: true }),
      context: t.arg({ type: "String", required: false }),
    },
    async resolve(medium, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      const isOwner = await isMediumOwner(ctx.kv, medium.id, session.accountId);
      if (!isOwner) {
        const windowActive = await isMediumUploadWindowActive(
          ctx.kv,
          medium.id,
        );
        if (windowActive) throw new NotAuthorizedError();
      }
      const imageUrl = await ctx.disk.getUrl(medium.key);
      return await generateAltText({
        model: ctx.altTextGenerator,
        imageUrl,
        language: (args.language as Intl.Locale).baseName,
        context: args.context ?? undefined,
      });
    },
  }));

const MediumUploadHeader = builder.simpleObject("MediumUploadHeader", {
  fields: (t) => ({
    name: t.string(),
    value: t.string(),
  }),
});

const PostLink = builder.drizzleNode("postLinkTable", {
  variant: "PostLink",
  id: {
    column: (link) => link.id,
  },
  fields: (t) => ({
    url: t.field({
      type: "URL",
      resolve: (link) => new URL(link.url),
    }),
    title: t.exposeString("title", { nullable: true }),
    siteName: t.exposeString("siteName", { nullable: true }),
    type: t.exposeString("type", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
    author: t.exposeString("author", { nullable: true }),
    image: t.variant(PostLinkImage, {
      isNull: (link) => link.imageUrl == null,
    }),
    creator: t.relation("creator", { nullable: true }),
  }),
});

const PostLinkImage = builder.drizzleObject("postLinkTable", {
  variant: "PostLinkImage",
  fields: (t) => ({
    url: t.field({
      type: "URL",
      resolve(link) {
        if (link.imageUrl == null) {
          unreachable("Expected imageUrl to be not null");
        }
        return new URL(link.imageUrl);
      },
    }),
    alt: t.exposeString("imageAlt", { nullable: true }),
    type: t.expose("imageType", { type: "MediaType", nullable: true }),
    width: t.exposeInt("imageWidth", { nullable: true }),
    height: t.exposeInt("imageHeight", { nullable: true }),
  }),
});

builder.drizzleObjectField(PostLinkImage, "post", (t) => t.variant(PostLink));

const CreateNoteMediumInput = builder.inputType("CreateNoteMediumInput", {
  fields: (t) => ({
    mediumId: t.field({
      type: "UUID",
      required: true,
      description: "UUID of a Medium to attach to the note.",
    }),
    alt: t.string({
      required: true,
      description: "Alternative text for this note's use of the medium.",
    }),
  }),
});

builder.relayMutationField(
  "createNote",
  {
    inputFields: (t) => ({
      visibility: t.field({ type: PostVisibility, required: true }),
      content: t.field({ type: "Markdown", required: true }),
      language: t.field({ type: "Locale", required: true }),
      media: t.field({
        type: [CreateNoteMediumInput],
        required: false,
        defaultValue: [],
        description: "Media to attach to the note, in display order.",
      }),
      replyTargetId: t.globalID({
        for: [Note, Article, Question],
        required: false,
      }),
      quotedPostId: t.globalID({
        for: [Note, Article, Question],
        required: false,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      const {
        visibility,
        content,
        language,
        media,
        replyTargetId,
        quotedPostId,
      } = args.input;
      const attachedMedia = media ?? [];
      if (attachedMedia.length > 20) {
        throw new InvalidInputError("media");
      }
      let replyTarget: schema.Post & { actor: schema.Actor } | undefined;
      if (replyTargetId != null) {
        const post = await ctx.db.query.postTable.findFirst({
          with: {
            actor: {
              with: {
                followers: true,
                blockees: true,
                blockers: true,
              },
            },
            mentions: true,
          },
          where: { id: replyTargetId.id },
        });
        if (post == null || !isPostVisibleTo(post, ctx.account.actor)) {
          throw new InvalidInputError("replyTargetId");
        }
        replyTarget = post;
      }
      let quotedPost: schema.Post & { actor: schema.Actor } | undefined;
      if (quotedPostId != null) {
        const post = await ctx.db.query.postTable.findFirst({
          with: {
            actor: {
              with: {
                followers: true,
                blockees: true,
                blockers: true,
              },
            },
            mentions: true,
            sharedPost: {
              with: {
                actor: {
                  with: {
                    followers: true,
                    blockees: true,
                    blockers: true,
                  },
                },
                mentions: true,
              },
            },
          },
          where: { id: quotedPostId.id },
        });
        if (post == null || !isPostVisibleTo(post, ctx.account.actor)) {
          throw new InvalidInputError("quotedPostId");
        }
        // Validate against the effective original post to prevent bypassing
        // via a public share wrapper of a non-quotable original.
        const effectivePost = post.sharedPost ?? post;
        if (effectivePost.sharedPostId != null) {
          throw new InvalidInputError("quotedPostId");
        }
        if (!isPostVisibleTo(effectivePost, ctx.account.actor)) {
          throw new InvalidInputError("quotedPostId");
        }
        if (
          effectivePost.visibility !== "public" &&
          effectivePost.visibility !== "unlisted" &&
          !(effectivePost.visibility === "followers" &&
            effectivePost.actorId === ctx.account.actor.id)
        ) {
          throw new InvalidInputError("quotedPostId");
        }
        quotedPost = effectivePost;
      }
      return await withTransaction(ctx.fedCtx, async (context) => {
        const noteMedia = await Promise.all(
          attachedMedia.map(async (medium, i) => {
            const alt = medium.alt.trim();
            if (alt === "") throw new InvalidInputError(`media.${i}.alt`);
            const storedMedium = await context.data.db.query.mediumTable
              .findFirst({
                where: { id: medium.mediumId },
              });
            if (storedMedium == null) {
              throw new InvalidInputError(`media.${i}.mediumId`);
            }
            return { mediumId: medium.mediumId, alt };
          }),
        );
        const note = await createNote(
          context,
          {
            accountId: session.accountId,
            visibility: visibility === "PUBLIC"
              ? "public"
              : visibility === "UNLISTED"
              ? "unlisted"
              : visibility === "FOLLOWERS"
              ? "followers"
              : visibility === "DIRECT"
              ? "direct"
              : visibility === "NONE"
              ? "none"
              : assertNever(
                visibility,
                `Unknown value in Post.visibility: "${visibility}"`,
              ),
            content,
            language: language.baseName,
            media: noteMedia,
          },
          { replyTarget, quotedPost },
        );
        if (note == null) {
          throw new Error("Failed to create note");
        }
        return note;
      });
    },
  },
  {
    outputFields: (t) => ({
      note: t.field({
        type: Note,
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "saveArticleDraft",
  {
    inputFields: (t) => ({
      id: t.globalID({ for: [ArticleDraft], required: false }),
      uuid: t.field({
        type: "UUID",
        required: false,
        description: "Draft UUID to use when creating a new draft.",
      }),
      title: t.string({ required: true }),
      content: t.field({ type: "Markdown", required: true }),
      tags: t.stringList({ required: true }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw new NotAuthenticatedError();
      }
      const { id, title, content, tags } = args.input;
      if (id != null && args.input.uuid != null) {
        throw new InvalidInputError("uuid");
      }

      const draft = await updateArticleDraft(ctx.db, {
        id: id?.id ?? args.input.uuid ?? generateUuidV7(),
        accountId: session.accountId,
        title,
        content,
        tags,
      });
      if (draft == null) {
        throw new InvalidInputError(args.input.uuid == null ? "id" : "uuid");
      }

      return draft;
    },
  },
  {
    outputFields: (t) => ({
      draft: t.field({
        type: ArticleDraft,
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "deleteArticleDraft",
  {
    inputFields: (t) => ({
      id: t.globalID({ for: [ArticleDraft], required: true }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw new NotAuthenticatedError();
      }

      const deleted = await deleteArticleDraft(
        ctx.db,
        session.accountId,
        args.input.id.id,
      );

      if (!deleted) {
        throw new InvalidInputError("id");
      }

      return { deletedDraftId: args.input.id.id };
    },
  },
  {
    outputFields: (t) => ({
      deletedDraftId: t.globalID({
        resolve(result) {
          return { type: "ArticleDraft", id: result.deletedDraftId };
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "deletePost",
  {
    inputFields: (t) => ({
      id: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        SharedPostDeletionNotAllowedError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw new NotAuthenticatedError();
      }

      const post = await ctx.db.query.postTable.findFirst({
        with: { actor: true, replyTarget: true },
        where: { id: args.input.id.id },
      });

      if (post == null || post.actor.accountId !== session.accountId) {
        throw new InvalidInputError("id");
      }

      if (post.sharedPostId != null) {
        throw new SharedPostDeletionNotAllowedError("id");
      }

      await deletePost(ctx.fedCtx, post);

      return { deletedPostId: args.input.id };
    },
  },
  {
    outputFields: (t) => ({
      deletedPostId: t.globalID({
        resolve(result) {
          return {
            type: result.deletedPostId.typename,
            id: result.deletedPostId.id,
          };
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "publishArticleDraft",
  {
    inputFields: (t) => ({
      id: t.globalID({ for: [ArticleDraft], required: true }),
      slug: t.string({ required: true }),
      language: t.field({ type: "Locale", required: true }),
      allowLlmTranslation: t.boolean({ required: false }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw new NotAuthenticatedError();
      }

      // Get draft
      const drafts = await ctx.db
        .select()
        .from(articleDraftTable)
        .where(
          and(
            eq(articleDraftTable.id, args.input.id.id),
            eq(articleDraftTable.accountId, session.accountId),
          ),
        )
        .limit(1);
      const draft = drafts[0];

      if (!draft) {
        throw new InvalidInputError("id");
      }

      const { slug, language, allowLlmTranslation } = args.input;

      // Create article from draft
      const article = await withTransaction(ctx.fedCtx, async (context) => {
        const media = await context.data.db.query.articleDraftMediumTable
          .findMany({
            where: { articleDraftId: draft.id },
          });
        return await createArticle(context, {
          accountId: session.accountId,
          publishedYear: new Date().getFullYear(),
          slug,
          tags: draft.tags,
          allowLlmTranslation: allowLlmTranslation ?? true,
          title: draft.title,
          content: draft.content,
          language: language.baseName,
          media,
        });
      });

      if (!article) {
        throw new Error("Failed to publish article");
      }

      // Delete draft after successful publish
      await deleteArticleDraft(ctx.db, session.accountId, draft.id);

      return { article, deletedDraftId: draft.id };
    },
  },
  {
    outputFields: (t) => ({
      article: t.field({
        type: Article,
        resolve(result) {
          return result.article;
        },
      }),
      deletedDraftId: t.globalID({
        resolve(result) {
          return { type: "ArticleDraft", id: result.deletedDraftId };
        },
      }),
    }),
  },
);

builder.drizzleObjectField(
  Reaction,
  "post",
  (t) => t.relation("post", { type: Post }),
);

builder.relayMutationField(
  "addReactionToPost",
  {
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      emoji: t.string({ required: true }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const { postId, emoji } = args.input;

      if (!isReactionEmoji(emoji)) {
        throw new InvalidInputError("emoji");
      }

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          replyTarget: {
            with: { actor: true },
          },
          mentions: true,
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, ctx.account.actor)) {
        throw new InvalidInputError("postId");
      }

      const reaction = await react(
        ctx.fedCtx,
        ctx.account,
        post,
        emoji,
      );

      if (reaction != null) {
        return reaction;
      }

      const existingReaction = await ctx.db.query.reactionTable.findFirst({
        where: {
          postId: post.id,
          actorId: ctx.account.actor.id,
          emoji,
        },
      });

      if (existingReaction != null) {
        return existingReaction;
      }

      throw new Error("Failed to react to the post");
    },
  },
  {
    outputFields: (t) => ({
      reaction: t.drizzleField({
        type: Reaction,
        nullable: true,
        resolve(_query, result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "removeReactionFromPost",
  {
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      emoji: t.string({ required: true }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const { postId, emoji } = args.input;

      if (!isReactionEmoji(emoji)) {
        throw new InvalidInputError("emoji");
      }

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          replyTarget: {
            with: { actor: true },
          },
          mentions: true,
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, ctx.account.actor)) {
        throw new InvalidInputError("postId");
      }

      await undoReaction(
        ctx.fedCtx,
        ctx.account,
        post,
        emoji,
      );

      return { success: true };
    },
  },
  {
    outputFields: (t) => ({
      success: t.boolean({
        resolve() {
          return true;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "sharePost",
  {
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          replyTarget: {
            with: { actor: true },
          },
          mentions: true,
          sharedPost: {
            with: {
              actor: {
                with: {
                  followers: true,
                  blockees: true,
                  blockers: true,
                },
              },
              mentions: true,
            },
          },
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, ctx.account.actor)) {
        throw new InvalidInputError("postId");
      }

      // Validate sharing eligibility against the effective original post.
      // When the submitted post is itself a share wrapper, the sharing rules
      // apply to the original post's visibility, not the wrapper's.
      // Reject nested wrappers (share-of-share chains) outright; only
      // direct originals (sharedPostId == null) are authoritative.
      const effectivePost = post.sharedPost ?? post;
      if (effectivePost.sharedPostId != null) {
        throw new InvalidInputError("postId");
      }
      if (!isPostVisibleTo(effectivePost, ctx.account.actor)) {
        throw new InvalidInputError("postId");
      }
      if (
        effectivePost.visibility !== "public" &&
        effectivePost.visibility !== "unlisted" &&
        !(effectivePost.visibility === "followers" &&
          effectivePost.actorId === ctx.account.actor.id)
      ) {
        throw new InvalidInputError("postId");
      }

      const share = await sharePost(
        ctx.fedCtx,
        ctx.account,
        post,
      );

      return {
        share,
        originalPostId: postId.id,
      };
    },
  },
  {
    outputFields: (t) => ({
      share: t.field({
        type: Post,
        resolve(result) {
          return result.share;
        },
      }),
      originalPost: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.originalPostId } }),
          );
          return post!;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unsharePost",
  {
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          replyTarget: {
            with: { actor: true },
          },
          mentions: true,
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, ctx.account.actor)) {
        throw new InvalidInputError("postId");
      }

      const unshared = await unsharePost(
        ctx.fedCtx,
        ctx.account,
        post,
      );

      if (unshared == null) {
        throw new InvalidInputError("postId");
      }

      return { success: true, originalPostId: postId.id };
    },
  },
  {
    outputFields: (t) => ({
      originalPost: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.originalPostId } }),
          );
          return post!;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "bookmarkPost",
  {
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          mentions: true,
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, ctx.account.actor)) {
        throw new InvalidInputError("postId");
      }

      await createBookmark(ctx.db, ctx.account, post);

      return { postId: postId.id };
    },
  },
  {
    outputFields: (t) => ({
      post: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.postId } }),
          );
          return post!;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unbookmarkPost",
  {
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      await deleteBookmark(ctx.db, ctx.account, post);

      return { postId: postId.id, unbookmarkedPostId: postId };
    },
  },
  {
    outputFields: (t) => ({
      post: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.postId } }),
          );
          return post!;
        },
      }),
      unbookmarkedPostId: t.globalID({
        resolve(result) {
          return {
            type: result.unbookmarkedPostId.typename,
            id: result.unbookmarkedPostId.id,
          };
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "pinPost",
  {
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      const pin = await pinPostModel(ctx.fedCtx, ctx.account.actor, post);
      if (pin == null) {
        throw new InvalidInputError("postId");
      }

      return { postId: postId.id };
    },
  },
  {
    outputFields: (t) => ({
      post: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.postId } }),
          );
          return post!;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unpinPost",
  {
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      const pin = await unpinPostModel(ctx.fedCtx, ctx.account.actor, post);
      if (pin == null) {
        throw new InvalidInputError("postId");
      }

      return { postId: postId.id, unpinnedPostId: postId };
    },
  },
  {
    outputFields: (t) => ({
      post: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.postId } }),
          );
          return post!;
        },
      }),
      unpinnedPostId: t.globalID({
        resolve(result) {
          return {
            type: result.unpinnedPostId.typename,
            id: result.unpinnedPostId.id,
          };
        },
      }),
    }),
  },
);

builder.queryField("articleDraft", (t) =>
  t.field({
    type: ArticleDraft,
    nullable: true,
    args: {
      id: t.arg.globalID({ for: [ArticleDraft], required: false }),
      uuid: t.arg({ type: "UUID", required: false }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) return null;

      // At least one of id or uuid must be provided
      if (!args.id && !args.uuid) {
        throw new Error("Either id or uuid must be provided");
      }

      // Use uuid if provided, otherwise use id
      const draftId = args.uuid ?? args.id!.id;

      const drafts = await ctx.db
        .select()
        .from(articleDraftTable)
        .where(
          and(
            eq(articleDraftTable.id, draftId),
            eq(articleDraftTable.accountId, ctx.account.id),
          ),
        )
        .limit(1);

      return drafts[0] ?? null;
    },
  }));

builder.queryField("postByUrl", (t) =>
  t.field({
    type: Post,
    nullable: true,
    args: {
      url: t.arg.string({ required: true }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) return null;
      const parsed = parseHttpUrl(args.url.trim());
      if (parsed == null) return null;
      const account = ctx.account;
      const looked = await lookupPostByUrl(ctx, parsed);
      if (looked == null) return null;
      const postId = looked.id;
      const withRelations = {
        actor: {
          with: {
            followers: {
              where: { followerId: account.actor.id },
            },
            blockees: {
              where: { blockeeId: account.actor.id },
            },
            blockers: {
              where: { blockerId: account.actor.id },
            },
          },
        },
        mentions: true,
      } as const;
      const post = await ctx.db.query.postTable.findFirst({
        with: withRelations,
        where: { id: postId },
      });
      if (post == null) return null;
      if (!isPostVisibleTo(post, account.actor)) return null;
      return post;
    },
  }));

builder.queryField("articleByYearAndSlug", (t) =>
  t.drizzleField({
    type: Article,
    nullable: true,
    args: {
      handle: t.arg.string({ required: true }),
      idOrYear: t.arg.string({ required: true }),
      slug: t.arg.string({ required: true }),
    },
    async resolve(query, _, args, ctx) {
      if (!/^\d+$/.test(args.idOrYear)) return null;
      const year = parseInt(args.idOrYear, 10);
      if (!Number.isFinite(year)) return null;

      let handle = args.handle;
      if (handle.startsWith("@")) handle = handle.substring(1);
      const split = handle.split("@");

      let actor;
      if (split.length === 2) {
        const [username, host] = split;
        actor = await ctx.db.query.actorTable.findFirst({
          where: {
            username,
            OR: [{ instanceHost: host }, { handleHost: host }],
          },
        });
      } else if (split.length === 1) {
        actor = await ctx.db.query.actorTable.findFirst({
          where: { username: split[0], accountId: { isNotNull: true } },
        });
      }
      if (actor == null) return null;

      // Only local actors have articles with sources
      if (actor.accountId == null) return null;

      const account = await ctx.db.query.accountTable.findFirst({
        where: { id: actor.accountId },
      });
      if (account == null) return null;

      const source = await ctx.db.query.articleSourceTable.findFirst({
        where: {
          accountId: account.id,
          publishedYear: year,
          slug: args.slug,
        },
      });
      if (source == null) return null;

      const visibility = getPostVisibilityFilter(ctx.account?.actor ?? null);
      return await ctx.db.query.postTable.findFirst(
        query({
          where: {
            AND: [
              {
                type: "Article",
                actorId: actor.id,
                articleSourceId: source.id,
              },
              visibility,
            ],
          },
        }),
      ) ?? null;
    },
  }));

const UpdateArticleMediumInput = builder.inputType("UpdateArticleMediumInput", {
  fields: (t) => ({
    mediumId: t.field({
      type: "UUID",
      required: true,
      description: "UUID of a Medium to make available to the article source.",
    }),
    key: t.string({
      required: false,
      description:
        "Key used in article markdown as hp-medium:KEY. Defaults to mediumId.",
    }),
  }),
});

builder.relayMutationField(
  "updateArticle",
  {
    inputFields: (t) => ({
      articleId: t.globalID({ for: [Article], required: true }),
      title: t.string({ required: false }),
      content: t.field({ type: "Markdown", required: false }),
      tags: t.stringList({ required: false }),
      language: t.field({ type: "Locale", required: false }),
      allowLlmTranslation: t.boolean({ required: false }),
      media: t.field({
        type: [UpdateArticleMediumInput],
        required: false,
        description:
          "Media to make available to hp-medium:KEY references in the updated article markdown.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw new NotAuthenticatedError();
      }

      const articleId = args.input.articleId.id;
      // Find the post and its articleSource
      const post = await ctx.db.query.postTable.findFirst({
        where: { id: articleId },
        with: { articleSource: true },
      });
      if (post == null || post.articleSource == null) {
        throw new InvalidInputError("articleId");
      }

      // Verify ownership
      if (post.articleSource.accountId !== session.accountId) {
        throw new InvalidInputError("articleId");
      }

      const media: { key: string; mediumId: Uuid }[] = [];
      for (const [i, mediumInput] of (args.input.media ?? []).entries()) {
        const medium = await ctx.db.query.mediumTable.findFirst({
          where: { id: mediumInput.mediumId },
        });
        if (medium == null) {
          throw new InvalidInputError(`media.${i}.mediumId`);
        }
        const key = mediumInput.key?.trim() || medium.id;
        if (!key.match(/^[A-Za-z0-9._:/-]+$/)) {
          throw new InvalidInputError(`media.${i}.key`);
        }
        media.push({ key, mediumId: medium.id });
      }

      let updated;
      try {
        updated = await updateArticle(ctx.fedCtx, post.articleSource.id, {
          title: args.input.title ?? undefined,
          content: args.input.content ?? undefined,
          tags: args.input.tags ?? undefined,
          language: args.input.language?.baseName ?? undefined,
          allowLlmTranslation: args.input.allowLlmTranslation ?? undefined,
          media: args.input.media == null ? undefined : media,
        });
      } catch (e) {
        if (e instanceof LanguageChangeWithTranslationsError) {
          throw new InvalidInputError("language");
        }
        throw e;
      }
      if (updated == null) {
        throw new InvalidInputError("articleId");
      }

      return updated;
    },
  },
  {
    outputFields: (t) => ({
      article: t.field({
        type: Article,
        resolve: (post) => post,
      }),
    }),
  },
);

builder.relayMutationField(
  "requestArticleTranslation",
  {
    inputFields: (t) => ({
      articleId: t.globalID({ for: [Article], required: true }),
      targetLanguage: t.field({ type: "Locale", required: true }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        LlmTranslationNotAllowedError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: args.input.articleId.id },
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          mentions: true,
          articleSource: {
            with: { contents: true },
          },
        },
      });
      if (
        post == null ||
        post.type !== "Article" ||
        post.articleSource == null ||
        !isPostVisibleTo(post, ctx.account.actor)
      ) {
        throw new InvalidInputError("articleId");
      }
      if (!post.articleSource.allowLlmTranslation) {
        throw new LlmTranslationNotAllowedError("DISABLED");
      }
      const original = getOriginalArticleContent(post.articleSource);
      if (original == null) {
        throw new InvalidInputError("articleId");
      }
      // The `Locale` scalar accepts any syntactically valid BCP 47
      // tag, but the `[lang]` route only serves locales that pass
      // `normalizeLocale` (i.e. the `POSSIBLE_LOCALES` whitelist
      // used across the project).  Run the same check here so an
      // API client cannot enqueue a translation for a tag the
      // canonical article URL flow will never display.
      const targetLanguage = normalizeLocale(
        args.input.targetLanguage.baseName,
      );
      if (targetLanguage == null) {
        throw new InvalidInputError("targetLanguage");
      }
      // Reject targets that share the source's *language and script*
      // subtags after maximization (so `en` -> `en-US` and `ko` ->
      // `ko-KR` are blocked because they both maximize to the same
      // `language`+`script` pair, but `zh-CN` -> `zh-TW` is allowed
      // because Simplified vs Traditional script genuinely produces a
      // different translation output).  `Article.contents` negotiates
      // among available locales rather than requiring exact tags, so
      // permitting a same-script variant would create a redundant
      // placeholder row whose canonical URL would negotiate back to
      // the existing source content and leave the newly inserted row
      // unreachable; a different-script variant has its own canonical
      // URL slot in the negotiation result.
      const targetMax = new Intl.Locale(targetLanguage).maximize();
      const originalMax = new Intl.Locale(original.language).maximize();
      if (
        targetMax.language === originalMax.language &&
        targetMax.script === originalMax.script
      ) {
        throw new LlmTranslationNotAllowedError("SAME_LANGUAGE");
      }

      // Skip enqueueing if a *completed* translation for the target
      // locale already exists.  `startArticleContentTranslation` is
      // already idempotent against this case (it returns early without
      // calling the translator), but checking here against the
      // already-fetched `articleSource.contents` lets the resolver
      // avoid the extra DB round-trip and makes the no-op intent
      // explicit at the resolver layer.  In-progress and stale rows
      // are intentionally not short-circuited here so the model layer
      // can re-queue them per its 30-minute staleness window.
      const alreadyTranslated = post.articleSource.contents.some(
        (c) =>
          !c.beingTranslated && normalizeLocale(c.language) === targetLanguage,
      );
      if (!alreadyTranslated) {
        await startArticleContentTranslation(ctx.fedCtx, {
          content: original,
          targetLanguage,
          requester: ctx.account,
        });
      }

      return post;
    },
  },
  {
    outputFields: (t) => ({
      article: t.field({
        type: Article,
        resolve: (post) => post,
      }),
    }),
  },
);

builder.relayMutationField(
  "createMedium",
  {
    inputFields: (t) => ({
      url: t.field({
        type: "URL",
        required: true,
        description:
          "Image URL to import. Data URLs, HTTP, and HTTPS are supported.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw new NotAuthenticatedError();
      }
      let medium: schema.Medium | undefined;
      try {
        medium = await createMediumFromUrl(
          ctx.db,
          ctx.disk,
          args.input.url,
          { userAgentUrl: new URL(ctx.fedCtx.canonicalOrigin) },
        );
      } catch (error) {
        if (!(error instanceof UnsafeMediumUrlError)) throw error;
      }
      if (medium == null) {
        throw new InvalidInputError("url");
      }
      return medium;
    },
  },
  {
    outputFields: (t) => ({
      medium: t.field({
        type: Medium,
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

interface MediumUploadStart {
  uploadId: Uuid;
  uploadUrl: URL;
  method: string;
  headers: { name: string; value: string }[];
  expires: Date;
}

builder.relayMutationField(
  "startMediumUpload",
  {
    inputFields: (t) => ({
      contentType: t.field({
        type: "MediaType",
        required: true,
        description: "Original image content type.",
      }),
      contentLength: t.int({
        required: true,
        description: "Exact number of bytes the client will upload.",
      }),
    }),
  },
  {
    errors: { types: [NotAuthenticatedError, InvalidInputError] },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      if (
        !SUPPORTED_MEDIUM_IMAGE_TYPES.includes(
          args.input.contentType as typeof SUPPORTED_MEDIUM_IMAGE_TYPES[number],
        )
      ) {
        throw new InvalidInputError("contentType");
      }
      if (
        args.input.contentLength < 1 ||
        args.input.contentLength > MAX_STREAMING_MEDIUM_IMAGE_SIZE
      ) {
        throw new InvalidInputError("contentLength");
      }
      const upload = await createMediumUploadSession(
        ctx.kv,
        session.accountId,
        args.input.contentType,
        args.input.contentLength,
      );
      let uploadUrl: URL;
      try {
        uploadUrl = new URL(
          await ctx.disk.getSignedUploadUrl(upload.key, {
            contentType: upload.contentType,
            contentSize: upload.contentLength,
            contentLength: upload.contentLength,
            expiresIn: "30mins",
          }),
        );
      } catch {
        uploadUrl = new URL(`/medium-uploads/${upload.id}`, ctx.request.url);
        uploadUrl.searchParams.set("token", upload.token);
      }
      return {
        uploadId: upload.id,
        uploadUrl,
        method: "PUT",
        headers: [{ name: "Content-Type", value: upload.contentType }],
        expires: new Date(Date.now() + MEDIUM_UPLOAD_TTL_MS),
      } satisfies MediumUploadStart;
    },
  },
  {
    outputFields: (t) => ({
      uploadId: t.field({
        type: "UUID",
        resolve: (result) => result.uploadId,
      }),
      uploadUrl: t.field({
        type: "URL",
        resolve: (result) => result.uploadUrl,
      }),
      method: t.string({ resolve: (result) => result.method }),
      headers: t.field({
        type: [MediumUploadHeader],
        resolve: (result) => result.headers,
      }),
      expires: t.field({
        type: "DateTime",
        resolve: (result) => result.expires,
      }),
    }),
  },
);

builder.relayMutationField(
  "finishMediumUpload",
  {
    inputFields: (t) => ({
      uploadId: t.field({ type: "UUID", required: true }),
    }),
  },
  {
    errors: { types: [NotAuthenticatedError, InvalidInputError] },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      const upload = await getMediumUploadSession(ctx.kv, args.input.uploadId);
      if (upload == null || upload.accountId !== session.accountId) {
        throw new InvalidInputError("uploadId");
      }
      try {
        let metadata: { contentLength: number };
        try {
          metadata = await ctx.disk.getMetaData(upload.key);
        } catch {
          throw new InvalidInputError("uploadId");
        }
        if (
          metadata.contentLength !== upload.contentLength ||
          metadata.contentLength > MAX_STREAMING_MEDIUM_IMAGE_SIZE
        ) {
          throw new InvalidInputError("uploadId");
        }
        let bytes: Uint8Array;
        try {
          bytes = await ctx.disk.getBytes(upload.key);
        } catch {
          throw new InvalidInputError("uploadId");
        }
        if (bytes.byteLength !== upload.contentLength) {
          throw new InvalidInputError("uploadId");
        }
        const medium = await createMediumFromBytes(ctx.db, ctx.disk, bytes, {
          maxSize: MAX_STREAMING_MEDIUM_IMAGE_SIZE,
          contentType: upload.contentType,
        });
        if (medium == null) throw new InvalidInputError("uploadId");
        await setMediumOwner(ctx.kv, medium.id, session.accountId);
        return medium;
      } finally {
        try {
          await ctx.disk.delete(upload.key);
        } catch (error) {
          logger.warn(
            "Failed to delete temporary medium upload {key}: {error}",
            {
              key: upload.key,
              error,
            },
          );
        }
        try {
          await deleteMediumUploadSession(ctx.kv, upload.id);
        } catch (error) {
          logger.warn("Failed to delete medium upload session {id}: {error}", {
            id: upload.id,
            error,
          });
        }
      }
    },
  },
  {
    outputFields: (t) => ({
      medium: t.field({
        type: Medium,
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

interface AttachedArticleDraftMedium {
  key: string;
  medium: schema.Medium;
}

builder.relayMutationField(
  "attachArticleDraftMedium",
  {
    inputFields: (t) => ({
      draftId: t.field({ type: "UUID", required: true }),
      mediumId: t.field({ type: "UUID", required: true }),
      key: t.string({
        required: false,
        description:
          "Key used in article markdown as hp-medium:KEY. Defaults to mediumId.",
      }),
    }),
  },
  {
    errors: { types: [NotAuthenticatedError, InvalidInputError] },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      let draft = await ctx.db.query.articleDraftTable.findFirst({
        where: {
          id: args.input.draftId,
          accountId: session.accountId,
        },
      });
      if (draft == null) {
        const inserted = await ctx.db.insert(articleDraftTable).values({
          id: args.input.draftId,
          accountId: session.accountId,
          title: "",
          content: "",
          tags: [],
        }).onConflictDoNothing().returning();
        draft = inserted[0];
      }
      if (draft == null) throw new InvalidInputError("draftId");
      const medium = await ctx.db.query.mediumTable.findFirst({
        where: { id: args.input.mediumId },
      });
      if (medium == null) throw new InvalidInputError("mediumId");
      const key = args.input.key?.trim() || medium.id;
      if (!key.match(/^[A-Za-z0-9._:/-]+$/)) {
        throw new InvalidInputError("key");
      }
      await ctx.db.insert(articleDraftMediumTable).values({
        articleDraftId: draft.id,
        key,
        mediumId: medium.id,
      }).onConflictDoUpdate({
        target: [
          articleDraftMediumTable.articleDraftId,
          articleDraftMediumTable.key,
        ],
        set: { mediumId: medium.id },
      });
      return { key, medium } satisfies AttachedArticleDraftMedium;
    },
  },
  {
    outputFields: (t) => ({
      key: t.string({ resolve: (result) => result.key }),
      medium: t.field({
        type: Medium,
        resolve: (result) => result.medium,
      }),
    }),
  },
);
