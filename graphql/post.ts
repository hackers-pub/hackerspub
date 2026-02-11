import { isReactionEmoji, renderCustomEmojis } from "@hackerspub/models/emoji";
import { stripHtml } from "@hackerspub/models/html";
import { negotiateLocale } from "@hackerspub/models/i18n";
import { renderMarkup } from "@hackerspub/models/markup";
import {
  createArticle,
  deleteArticleDraft,
  updateArticleDraft,
} from "@hackerspub/models/article";
import { createNote } from "@hackerspub/models/note";
import {
  isPostSharedBy,
  isPostVisibleTo,
  sharePost,
  unsharePost,
} from "@hackerspub/models/post";
import { react, undoReaction } from "@hackerspub/models/reaction";
import { articleDraftTable } from "@hackerspub/models/schema";
import type * as schema from "@hackerspub/models/schema";
import { withTransaction } from "@hackerspub/models/tx";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { and, eq } from "drizzle-orm";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { unreachable } from "@std/assert";
import { assertNever } from "@std/assert/unstable-never";
import { Account } from "./account.ts";
import { Actor } from "./actor.ts";
import { builder, Node } from "./builder.ts";
import { PostVisibility, toPostVisibility } from "./postvisibility.ts";
import { Reactable, Reaction } from "./reactable.ts";
import { NotAuthenticatedError } from "./session.ts";

const logger = getLogger(["hackerspub", "graphql", "post"]);

class InvalidInputError extends Error {
  public constructor(public readonly inputPath: string) {
    super(`Invalid input - ${inputPath}`);
  }
}

export const PostType = builder.enumType("PostType", {
  values: ["ARTICLE", "NOTE", "QUESTION"],
});

builder.objectType(InvalidInputError, {
  name: "InvalidInputError",
  fields: (t) => ({
    inputPath: t.expose("inputPath", { type: "String" }),
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
      resolve: (post) => renderCustomEmojis(post.contentHtml, post.emojis),
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
    viewerHasShared: t.boolean({
      select: {
        columns: { id: true },
      },
      async resolve(post, _, ctx) {
        if (ctx.account == null) return false;
        return await isPostSharedBy(ctx.db, post, ctx.account);
      },
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
    publishedYear: t.int({
      select: {
        with: {
          articleSource: {
            columns: { publishedYear: true },
          },
        },
      },
      resolve: (post) => post.articleSource!.publishedYear,
    }),
    slug: t.string({
      select: {
        with: {
          articleSource: {
            columns: { slug: true },
          },
        },
      },
      resolve: (post) => post.articleSource!.slug,
    }),
    tags: t.stringList({
      select: {
        with: {
          articleSource: {
            columns: { tags: true },
          },
        },
      },
      resolve: (post) => post.articleSource!.tags,
    }),
    allowLlmTranslation: t.boolean({
      select: {
        with: {
          articleSource: {
            columns: { allowLlmTranslation: true },
          },
        },
      },
      resolve: (post) => post.articleSource!.allowLlmTranslation,
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
      select: (args) => ({
        with: {
          articleSource: {
            with: {
              contents: {
                where: {
                  beingTranslated: args.includeBeingTranslated ?? false,
                },
              },
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
    type: Account,
    select: (_, __, nestedSelection) => ({
      with: {
        articleSource: {
          with: {
            account: nestedSelection(),
          },
        },
      },
    }),
    resolve: (post) => post.articleSource!.account,
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
  fields: (t) => ({
    poll: t.relation("poll"),
  }),
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
        });
        return renderCustomEmojis(html.html, content.source.post.emojis);
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

builder.relayMutationField(
  "createNote",
  {
    inputFields: (t) => ({
      visibility: t.field({ type: PostVisibility, required: true }),
      content: t.field({ type: "Markdown", required: true }),
      language: t.field({ type: "Locale", required: true }),
      // TODO: media
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
      if (session == null) {
        throw new NotAuthenticatedError();
      }
      const { visibility, content, language, replyTargetId, quotedPostId } =
        args.input;
      let replyTarget: schema.Post & { actor: schema.Actor } | undefined;
      if (replyTargetId != null) {
        replyTarget = await ctx.db.query.postTable.findFirst({
          with: { actor: true },
          where: { id: replyTargetId.id },
        });
        if (replyTarget == null) {
          throw new InvalidInputError("replyTargetId");
        }
      }
      let quotedPost: schema.Post & { actor: schema.Actor } | undefined;
      if (quotedPostId != null) {
        quotedPost = await ctx.db.query.postTable.findFirst({
          with: { actor: true },
          where: { id: quotedPostId.id },
        });
        if (quotedPost == null) {
          throw new InvalidInputError("quotedPostId");
        }
      }
      return await withTransaction(ctx.fedCtx, async (context) => {
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
            media: [], // TODO
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

      const draft = await updateArticleDraft(ctx.db, {
        id: id?.id ?? generateUuidV7(),
        accountId: session.accountId,
        title,
        content,
        tags,
      });

      let contentHtml = "";
      try {
        const rendered = await renderMarkup(ctx.fedCtx, content);
        contentHtml = rendered.html;
      } catch (error) {
        logger.error(
          "Failed to render markdown preview for draft {draftId}: {error}",
          {
            draftId: draft.id,
            accountId: session.accountId,
            contentLength: content.length,
            error,
          },
        );
      }

      return { draft, contentHtml };
    },
  },
  {
    outputFields: (t) => ({
      draft: t.field({
        type: ArticleDraft,
        resolve(result) {
          return result.draft;
        },
      }),
      contentHtml: t.field({
        type: "HTML",
        description: "The rendered HTML of the draft's markdown content.",
        resolve(result) {
          return result.contentHtml;
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
        return await createArticle(context, {
          accountId: session.accountId,
          publishedYear: new Date().getFullYear(),
          slug,
          tags: draft.tags,
          allowLlmTranslation: allowLlmTranslation ?? true,
          title: draft.title,
          content: draft.content,
          language: language.baseName,
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
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, ctx.account.actor)) {
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
