import { renderCustomEmojis } from "@hackerspub/models/emoji";
import { negotiateLocale } from "@hackerspub/models/i18n";
import { renderMarkup } from "@hackerspub/models/markup";
import { createNote } from "@hackerspub/models/note";
import type * as schema from "@hackerspub/models/schema";
import { withTransaction } from "@hackerspub/models/tx";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { unreachable } from "@std/assert";
import { assertNever } from "@std/assert/unstable-never";
import { Account } from "./account.ts";
import { Actor } from "./actor.ts";
import { builder, Node } from "./builder.ts";
import { Reactable } from "./reactable.ts";

const PostVisibility = builder.enumType("PostVisibility", {
  values: [
    "PUBLIC",
    "UNLISTED",
    "FOLLOWERS",
    "DIRECT",
    "NONE",
  ] as const,
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
        return post.visibility === "public"
          ? "PUBLIC"
          : post.visibility === "unlisted"
          ? "UNLISTED"
          : post.visibility === "followers"
          ? "FOLLOWERS"
          : post.visibility === "direct"
          ? "DIRECT"
          : post.visibility === "none"
          ? "NONE"
          : assertNever(
            post.visibility,
            `Unknown value in \`Post.visibility\`: "${post.visibility}"`,
          );
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
  select: {
    with: {
      articleSource: true,
    },
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
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw new Error("Not authenticated.");
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
          throw new Error("Reply target not found.");
        }
      }
      let quotedPost: schema.Post & { actor: schema.Actor } | undefined;
      if (quotedPostId != null) {
        quotedPost = await ctx.db.query.postTable.findFirst({
          with: { actor: true },
          where: { id: quotedPostId.id },
        });
        if (quotedPost == null) {
          throw new Error("Quoted post not found.");
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
          throw new Error("Failed to create note.");
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
