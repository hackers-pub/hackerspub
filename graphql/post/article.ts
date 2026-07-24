import { and, eq } from "drizzle-orm";
import { getAvatarUrl } from "@hackerspub/models/account";
import {
  getArticleDraftMediumUrls,
  getArticleSourceMediumUrls,
} from "@hackerspub/models/article";
import { renderCustomEmojis } from "@hackerspub/models/emoji";
import {
  addExternalLinkTargets,
  transformMentions,
} from "@hackerspub/models/html";
import { negotiateLocale } from "@hackerspub/models/i18n";
import {
  getMissingArticleMediumLabel,
  renderMarkup,
} from "@hackerspub/models/markup";
import { articleContentTable } from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";
import { Account } from "../account.ts";
import { builder, type UserContext } from "../builder.ts";
import { putArticleOgImage } from "../og.ts";
import { Reactable } from "../reactable.ts";
import {
  articleContentOgImageComplexity,
  isCensoredForViewer,
  Post,
  sanctionActorSelection,
} from "./core.ts";

export const Article = builder.drizzleNode("postTable", {
  variant: "Article",
  description:
    "A long-form blog article written on this platform. Articles have a " +
    "title, year-based URL slug, and can have multiple `ArticleContent` " +
    "translations. Remote articles federated from other instances lack a " +
    "local `articleSource` and will have `null` for `slug`, `publishedYear`, and `tags`.",
  interfaces: [Post, Reactable],
  id: {
    column: (post) => post.id,
  },
  fields: (t) => ({
    // articleSource is only present for locally-authored articles. Articles
    // federated in from remote servers don't have one — the upstream
    // metadata lives on the post itself, not in our articleSource table —
    // so the fields below have to be nullable to represent that.
    sourceId: t.expose("articleSourceId", {
      type: "UUID",
      nullable: true,
      description:
        "The local source UUID for this article (`articleSourceTable.id`). " +
        "Non-null only for source-backed local articles (articles originally " +
        "composed on this instance). Use it when calling APIs that need to " +
        "resolve the article's attached media, e.g. `renderMarkdown` with " +
        "an `articleSourceId` argument for edit-time previews. `null` for " +
        "articles federated in from remote instances.",
    }),
    publishedYear: t.int({
      nullable: true,
      description:
        "The year the article was first published, used as part of its " +
        "URL path (e.g., `/@alice/2024/my-article`). `null` for articles " +
        "federated in from remote instances.",
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
      description:
        "URL slug for the article, used together with `publishedYear` " +
        "to build its permalink. `null` for remote articles.",
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
      description:
        "Author-assigned tags for this article. `null` for articles " +
        "federated in from remote instances.  Empty when the post is " +
        "censored, or its author is hidden by a moderation sanction, and the viewer is neither the author nor a moderator, " +
        "since the tags are part of the censored content.",
      select: {
        columns: { censored: true, actorId: true },
        with: {
          actor: sanctionActorSelection,
          articleSource: {
            columns: { tags: true },
          },
        },
      },
      resolve: (post, _, ctx) => {
        if (isCensoredForViewer(post, ctx)) return [];
        return post.articleSource?.tags ?? null;
      },
    }),
    allowLlmTranslation: t.boolean({
      nullable: true,
      description:
        "Whether the author has enabled LLM-based translation for this " +
        "article. `null` for articles federated from remote instances.",
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
      description:
        "All available language versions of this article's content. " +
        "Pass `language` to get only the best-matching locale (BCP 47 " +
        "negotiation). Pass `includeBeingTranslated: true` to also include " +
        "language versions whose LLM translation is still in progress.  " +
        "Empty when the article is censored or its author is hidden by " +
        "a moderation sanction, and the viewer is neither " +
        "its author nor a moderator.",
      args: {
        language: t.arg({
          type: "Locale",
          required: false,
          description:
            "Preferred BCP 47 locale for content negotiation. Omit it to " +
            "return every eligible language version.",
        }),
        includeBeingTranslated: t.arg({
          type: "Boolean",
          required: false,
          defaultValue: false,
          description:
            "Whether to include language versions whose LLM translation is " +
            "still in progress. Defaults to `false`.",
        }),
      },
      complexity: (args) => ({
        field: 1,
        multiplier: args.language == null ? 10 : 1,
      }),
      select: (args) => ({
        columns: { actorId: true, censored: true },
        with: {
          actor: sanctionActorSelection,
          articleSource: {
            with: {
              contents: args.includeBeingTranslated
                ? {}
                : { where: { beingTranslated: false } },
            },
          },
        },
      }),
      resolve(post, args, ctx) {
        if (isCensoredForViewer(post, ctx)) return [];
        const contents = post.articleSource?.contents ?? [];
        if (args.language == null) return contents;
        const availableLocales = contents.map((c) => c.language);
        const selectedLocale = negotiateLocale(args.language, availableLocales);
        return contents.filter((c) => c.language === selectedLocale?.baseName);
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
  }),
);

export const ArticleDraft = builder.drizzleNode("articleDraftTable", {
  variant: "ArticleDraft",
  description:
    "An unpublished article draft. Visible only to the owning account. " +
    "Drafts are promoted to `Article`s via the `publishArticleDraft` mutation.",
  // The `articleDraft` query already scopes lookups to the owner, but a
  // draft's global ID must not let anyone else read it via `node(id:)`.
  // Owner-only, matching the query (drafts belong to personal accounts;
  // not even moderators can read them).
  authScopes: (draft, ctx) =>
    ctx.account != null && draft.accountId === ctx.account.id,
  runScopesOnType: true,
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

/**
 * Whether this article content version belongs to a censored article whose
 * content must be redacted for the current viewer (the author and
 * moderators are exempt). Guards direct `ArticleContent` node access,
 * which bypasses `Article.contents`.
 */
function isArticleContentCensoredForViewer(
  content: { source: { post: { censored: Date | null; actorId: Uuid } } },
  ctx: UserContext,
): boolean {
  return isCensoredForViewer(content.source.post, ctx);
}

export const ArticleContent = builder.drizzleNode("articleContentTable", {
  name: "ArticleContent",
  description:
    "A single language version of an `Article`'s content. Each language is " +
    "stored separately; `Article.contents` lists all available translations. " +
    "Translated versions have a non-null `originalLanguage`; `translator` " +
    "can be `null` when the translating account was deleted.",
  id: {
    column: (content) => [content.sourceId, content.language],
  },
  fields: (t) => ({
    language: t.expose("language", {
      type: "Locale",
      description: "BCP 47 language tag identifying this content version.",
    }),
    title: t.field({
      type: "String",
      description:
        "The article's title in this language.  Empty when the article " +
        "is censored, or its author is hidden by a moderation sanction, " +
        "and the viewer is neither the author nor a " +
        "moderator.",
      select: {
        columns: { title: true },
        with: {
          source: {
            with: {
              post: {
                columns: { censored: true, actorId: true },
                with: { actor: sanctionActorSelection },
              },
            },
          },
        },
      },
      resolve: (content, _, ctx) =>
        isArticleContentCensoredForViewer(content, ctx) ? "" : content.title,
    }),
    summary: t.field({
      type: "String",
      nullable: true,
      select: {
        columns: { summary: true },
        with: {
          source: {
            with: {
              post: {
                columns: { censored: true, actorId: true },
                with: { actor: sanctionActorSelection },
              },
            },
          },
        },
      },
      resolve: (content, _, ctx) =>
        isArticleContentCensoredForViewer(content, ctx)
          ? null
          : content.summary,
      description:
        "`null` when the article is censored, or its author is hidden by " +
        "a moderation sanction, and the viewer is neither " +
        "its author nor a moderator.  Otherwise the " +
        "LLM-generated summary for this language version: `null` until " +
        "generation completes. Check `summaryStarted` to distinguish " +
        'between "not requested" and "in progress".',
    }),
    summaryStarted: t.expose("summaryStarted", {
      type: "DateTime",
      nullable: true,
      description:
        "When LLM summary generation was started for this content version. " +
        "`null` if summary generation has not been requested.",
    }),
    content: t.field({
      type: "HTML",
      description:
        "Rendered HTML of this language version, with media URLs resolved " +
        "and external links annotated.  Empty when the article is " +
        "censored, or its author is hidden by a moderation sanction, and the viewer is neither the author nor a moderator.",
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
                  actorId: true,
                  censored: true,
                  emojis: true,
                  tags: true,
                },
                with: {
                  actor: sanctionActorSelection,
                  mentions: {
                    with: { actor: true },
                  },
                },
              },
            },
          },
        },
      },
      async resolve(content, _, ctx) {
        if (isArticleContentCensoredForViewer(content, ctx)) return "";
        const html = await renderMarkup(ctx.fedCtx, content.content, {
          kv: ctx.kv,
          mediumUrls: await getArticleSourceMediumUrls(
            ctx.db,
            ctx.disk,
            content.sourceId,
          ),
          missingMediumLabel: getMissingArticleMediumLabel(content.language),
        });
        const post = content.source.post;
        let rendered = renderCustomEmojis(html.html, post.emojis);
        rendered = transformMentions(rendered, post.mentions, post.tags);
        return addExternalLinkTargets(
          rendered,
          new URL(ctx.fedCtx.canonicalOrigin),
        );
      },
    }),
    rawContent: t.field({
      type: "Markdown",
      description:
        "The raw markdown content for editing.  Empty when the article " +
        "is censored, or its author is hidden by a moderation sanction, " +
        "and the viewer is neither the author nor a " +
        "moderator.",
      select: {
        columns: { content: true },
        with: {
          source: {
            with: {
              post: {
                columns: { censored: true, actorId: true },
                with: { actor: sanctionActorSelection },
              },
            },
          },
        },
      },
      resolve(content, _, ctx) {
        if (isArticleContentCensoredForViewer(content, ctx)) return "";
        return content.content;
      },
    }),
    toc: t.field({
      type: "JSON",
      description:
        "Table of contents for the article content.  Empty when the " +
        "article is censored, or its author is hidden by a moderation " +
        "sanction, and the viewer is neither the author nor a " +
        "moderator.",
      select: {
        columns: { content: true, language: true, sourceId: true },
        with: {
          source: {
            with: {
              post: {
                columns: { censored: true, actorId: true },
                with: { actor: sanctionActorSelection },
              },
            },
          },
        },
      },
      async resolve(content, _, ctx) {
        if (isArticleContentCensoredForViewer(content, ctx)) return [];
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
      description:
        "The source language this content was translated from. Non-null " +
        "only for LLM-translated versions; `null` for original content.",
    }),
    translator: t.relation("translator", {
      nullable: true,
      description:
        "The account whose LLM translation produced this content version. " +
        "`null` for original (non-translated) content.",
    }),
    translationRequester: t.relation("translationRequester", {
      nullable: true,
      description:
        "The account that requested this translation. May differ from " +
        "`translator` if translations are requested on behalf of others.",
    }),
    beingTranslated: t.exposeBoolean("beingTranslated", {
      description:
        "Whether an LLM translation into this language is currently " +
        "in progress. When `true`, the content may be incomplete.",
    }),
    updated: t.expose("updated", { type: "DateTime" }),
    published: t.expose("published", { type: "DateTime" }),
    ogImageUrl: t.field({
      type: "URL",
      nullable: true,
      description:
        "The generated Open Graph preview image for this language " +
        "version.  `null` when the article is censored, or its author is " +
        "hidden by a moderation sanction, and the viewer " +
        "is neither its author nor a moderator: the image is rendered " +
        "from the title and excerpt and would otherwise leak censored " +
        "content.",
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
              post: {
                columns: { censored: true, actorId: true },
                with: { actor: sanctionActorSelection },
              },
            },
          },
        },
      },
      async resolve(content, _, ctx) {
        if (isArticleContentCensoredForViewer(content, ctx)) return null;
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
          await ctx.db
            .update(articleContentTable)
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
      description:
        "Canonical URL for this language version. For the article's " +
        "primary language this is `/@username/year/slug`; for other " +
        "language versions it appends `/{language}` to that path.",
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
