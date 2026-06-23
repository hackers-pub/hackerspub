import * as vocab from "@fedify/vocab";
import { generateAltText } from "@hackerspub/ai/alttext";
import { getLogger } from "@logtape/logtape";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { unreachable } from "@std/assert";
import { assertNever } from "@std/assert/unstable-never";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
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
  getBookmarkCountsForPosts,
} from "@hackerspub/models/bookmark";
import type { Database, Transaction } from "@hackerspub/models/db";
import {
  isReactionEmoji,
  type ReactionEmoji,
  renderCustomEmojis,
} from "@hackerspub/models/emoji";
import {
  addExternalLinkTargets,
  removeQuoteInlineFallback,
  sanitizeExcerptHtml,
  stripHtml,
  transformMentions,
  truncateHtml,
} from "@hackerspub/models/html";
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
import {
  createNote,
  QuotePolicyDeniedError,
  updateNote,
} from "@hackerspub/models/note";
import {
  OrganizationPermissionError,
  recordOrganizationPostAuthor,
} from "@hackerspub/models/organization";
import {
  arePostsPinnedBy,
  pinPost as pinPostModel,
  unpinPost as unpinPostModel,
} from "@hackerspub/models/pin";
import {
  canActorRequestQuotePost,
  deletePost,
  getCensoredPostExclusionFilter,
  getPostInteractionPolicies,
  getPostVisibilityFilter,
  getSanctionVisibleActorFilter,
  isActorSanctionHidden,
  isPostVisibleTo,
  normalizeQuotePolicyForVisibility,
  type PostInteractionPolicy,
  revokeQuote as revokeQuoteModel,
  sharePost,
  unsharePost,
} from "@hackerspub/models/post";
import { InvalidPollInputError } from "@hackerspub/models/poll";
import { createQuestion } from "@hackerspub/models/question";
import { react, undoReaction } from "@hackerspub/models/reaction";
import {
  actorTable,
  articleContentTable,
  articleDraftMediumTable,
  articleDraftTable,
  articleSourceMediumTable,
  postTable,
} from "@hackerspub/models/schema";
import type * as schema from "@hackerspub/models/schema";
import DataLoader from "dataloader";
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
import { createGraphQLError } from "graphql-yoga";
import { Account } from "./account.ts";
import { resolveActingAccountForMutation } from "./acting-account.ts";
import { Actor, isActorProfileHidden } from "./actor.ts";
import { builder, Node, type UserContext } from "./builder.ts";
import {
  ActorSuspendedError,
  InvalidInputError,
  NotAuthorizedError,
} from "./error.ts";
import { lookupPostByUrl, parseHttpUrl } from "./lookup.ts";
import { putArticleOgImage } from "./og.ts";
import { PostVisibility, toPostVisibility } from "./postvisibility.ts";
import {
  fromQuotePolicy,
  QuotePolicy,
  QuoteTargetState,
  toQuotePolicy,
  toQuoteTargetState,
} from "./quotepolicy.ts";
import { CustomEmoji, Reactable, Reaction } from "./reactable.ts";
import { NotAuthenticatedError } from "./session.ts";
import {
  type ActingAccountIdArg,
  actingAccountIdArgDescription,
  resolveViewerActorId,
} from "./viewer-actor.ts";

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
  description:
    "Discriminant used to filter a connection to a single post type. " +
    "This enum does not appear on the `Post` interface itself; use " +
    "__typename` or inline fragments to distinguish concrete types.",
  values: {
    ARTICLE: {
      description: "Long-form article with a title, year-based slug URL, and " +
        "optional multi-language translations.",
    },
    NOTE: {
      description: "Short microblog post (equivalent to a Mastodon Status or " +
        "ActivityPub Note).",
    },
    QUESTION: {
      description:
        "ActivityPub `Question` poll. Questions may originate locally via " +
        "`createQuestion` or remotely through federation.",
    },
  } as const,
});

const PostAttributionMode = builder.enumType("PostAttributionMode", {
  description:
    "How a post written through an organization account should display " +
    "the personal member who created it.",
  values: {
    ACTING_ACCOUNT_ONLY: {
      value: "acting_account_only",
      description: "Show only the acting account as the public author. For " +
        "organization posts, the member remains recorded for audit and " +
        "management but is not shown as a co-author.",
    },
    ACTING_ACCOUNT_WITH_VIEWER: {
      value: "acting_account_with_viewer",
      description:
        "Show the organization account as the primary author and the " +
        "personal member as a co-author.",
    },
  } as const,
});

const OrganizationPostAuthor = builder.objectRef<schema.OrganizationPostAuthor>(
  "OrganizationPostAuthor",
);

const LlmTranslationNotAllowedReasonRef = builder.enumType(
  "LlmTranslationNotAllowedReason",
  {
    values: {
      DISABLED: {
        description:
          "The article's author has opted out of LLM-based translation " +
          "for this article.",
      },
      SAME_LANGUAGE: {
        description:
          "The requested target language matches the article's existing " +
          "language; translation is a no-op.",
      },
    } as const,
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

async function loadOrganizationPostAuthorAccount(
  ctx: UserContext,
  id: Uuid,
) {
  const account = await ctx.db.query.accountTable.findFirst({
    where: { id },
    with: { actor: true },
  });
  if (account == null || account.actor == null) {
    throw createGraphQLError("Organization post attribution is broken.", {
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
  }
  return account;
}

OrganizationPostAuthor.implement({
  description:
    "Attribution metadata for a post written through an organization " +
    "account. The `Post.actor` remains the organization; this object " +
    "records which personal member created it and whether that member " +
    "should be shown as a co-author.",
  fields: (t) => ({
    attributionMode: t.field({
      type: PostAttributionMode,
      description:
        "Whether clients should display only the organization or include " +
        "the member as a co-author.",
      resolve: (author) => author.attributionMode,
    }),
    organization: t.field({
      type: Account,
      description: "The organization account that authored the post.",
      async resolve(author, _, ctx) {
        return await loadOrganizationPostAuthorAccount(
          ctx,
          author.organizationAccountId,
        );
      },
    }),
    member: t.field({
      type: Account,
      nullable: true,
      description:
        "The personal member account to show as a co-author. `null` when " +
        "`attributionMode` is `ACTING_ACCOUNT_ONLY`.",
      async resolve(author, _, ctx) {
        if (author.attributionMode !== "acting_account_with_viewer") {
          return null;
        }
        return await loadOrganizationPostAuthorAccount(
          ctx,
          author.memberAccountId,
        );
      },
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When this organization attribution record was created.",
    }),
  }),
});

interface PostActingAccountInput {
  actingAccountId?: { id: string } | null;
  attributionMode?: schema.PostAttributionMode | null;
}

interface PostManagementActingAccountInput {
  actingAccountId?: { id: string } | null;
}

interface ResolvedPostActingAccount {
  account: schema.Account & { actor: schema.Actor };
  memberAccountId: Uuid;
  attributionMode: schema.PostAttributionMode | null;
}

async function resolvePostActingAccount(
  ctx: UserContext,
  input: PostActingAccountInput,
): Promise<ResolvedPostActingAccount> {
  if (ctx.account == null) throw new NotAuthenticatedError();
  const account = await resolveActingAccountForMutation(ctx, input);
  if (account.kind !== "organization") {
    if (input.attributionMode != null) {
      throw new InvalidInputError("attributionMode");
    }
    return {
      account,
      memberAccountId: ctx.account.id,
      attributionMode: null,
    };
  }
  return {
    account,
    memberAccountId: ctx.account.id,
    attributionMode: input.attributionMode ?? "acting_account_only",
  };
}

async function recordPostActingAccount(
  db: Database | Transaction,
  postId: Uuid,
  resolved: ResolvedPostActingAccount,
): Promise<void> {
  if (resolved.attributionMode == null) return;
  await recordOrganizationPostAuthor(
    db,
    postId,
    resolved.account.id,
    resolved.memberAccountId,
    resolved.attributionMode,
  );
}

async function resolvePostManagementActingAccount(
  ctx: UserContext,
  input: PostManagementActingAccountInput,
  ownerAccountId: Uuid,
  inputPath: string,
): Promise<NonNullable<UserContext["account"]>> {
  const account = await resolveActingAccountForMutation(ctx, input);
  if (account.id !== ownerAccountId) {
    throw new InvalidInputError(inputPath);
  }
  return account;
}

/**
 * Whether the post's content must be redacted for the current viewer: it
 * is censored, or its author is hidden by a moderation sanction (a banned
 * local actor, or a remote actor under an active federation block), and
 * the viewer is neither its author nor a moderator.  The permalink itself
 * stays reachable (so a censorship notice can render); only the
 * content-bearing fields are emptied.  List queries exclude such posts
 * entirely; this redaction covers direct `node(id:)` lookups and nested
 * relations.
 *
 * Share wrappers carry denormalized copies of the boosted post's title,
 * content, and URL, so when the (loaded) `sharedPost` is censored or its
 * author is sanction-hidden the wrapper's content is redacted too; there
 * the exemption follows the boosted post's author, not the booster.
 */
function isCensoredForViewer(
  post: {
    censored: Date | null;
    actorId: Uuid;
    actor?: SanctionActorColumns | null;
    sharedPost?: {
      censored: Date | null;
      actorId: Uuid;
      actor?: SanctionActorColumns | null;
    } | null;
  },
  ctx: UserContext,
): boolean {
  return isRowCensoredForViewer(post, ctx) ||
    post.sharedPost != null && isRowCensoredForViewer(post.sharedPost, ctx);
}

type SanctionActorColumns = Pick<
  schema.Actor,
  "accountId" | "suspended" | "suspendedUntil"
>;

/**
 * The actor columns the redaction helpers need to evaluate the author's
 * sanction state; merged into the field selections that call them.
 */
const sanctionActorSelection = {
  columns: {
    accountId: true,
    suspended: true,
    suspendedUntil: true,
  },
} as const;

/**
 * Like {@link isCensoredForViewer}, but considers only the row itself,
 * ignoring any loaded `sharedPost`.  Used for the `sharedPost` relation
 * field: a wrapper of a censored post must keep the relation (the boosted
 * post redacts itself and exposes `censored` for the notice), while a
 * censored wrapper hides it entirely.
 */
function isRowCensoredForViewer(
  row: {
    censored: Date | null;
    actorId: Uuid;
    actor?: SanctionActorColumns | null;
  },
  ctx: UserContext,
): boolean {
  if (ctx.account?.moderator) return false;
  if (ctx.account?.actor.id === row.actorId) return false;
  if (row.censored != null) return true;
  return row.actor != null && isActorSanctionHidden(row.actor);
}

export const Post = builder.drizzleInterface("postTable", {
  variant: "Post",
  description:
    "Abstract base for all content types: `Note` (short microblog posts), " +
    "`Article` (long-form blog posts), and `Question` (polls from federated " +
    "instances). Most timeline and feed queries return this interface; " +
    "use `__typename` or inline fragments to access type-specific fields.  " +
    "Content-bearing fields are redacted (empty or `null`) when the post " +
    "is censored or its author is hidden by a moderation sanction (a " +
    "banned local actor, or a remote actor under an active federation " +
    "block), unless the viewer is the author or a moderator; list queries " +
    "exclude such posts entirely, so this matters for direct `node(id:)` " +
    "lookups and nested relations.",
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
    uuid: t.expose("id", {
      type: "UUID",
      description:
        "The post row's primary key, stable for the lifetime of the post. " +
        "⚠️ This is **not** the UUID embedded in `Post.url` for source-backed " +
        "local posts: local notes that originate here use `Note.sourceId` " +
        "(= `noteSourceTable.id`), local questions use `Question.sourceId`, " +
        "and local articles use `Article.publishedYear` + `Article.slug`. " +
        "The row PK is the right token for posts with no local source row: " +
        "federated remote posts, local share wrappers (boosts, which carry " +
        "no source and copy the shared post's URL), and remote `Question`s. " +
        "`actorByHandle.postByUuid` accepts either the row PK or a source " +
        "UUID, but resolving by `uuid` for a source-backed local post yields " +
        "a URL that differs from `Post.url`.",
    }),
    iri: t.field({
      type: "URL",
      description:
        "The post's ActivityPub IRI, used as its canonical identifier in " +
        "federation. For local posts this is an `/ap/…` endpoint; for " +
        "remote posts it is whatever IRI the originating instance assigned. " +
        "Prefer `url` for human-readable links.  When the post is censored " +
        "or its author is hidden by a moderation sanction, and the viewer " +
        "is neither the author nor a moderator, a remote IRI (or a boost " +
        "wrapper's, whose `url` is also nulled) is replaced with the local " +
        "permalink that renders the notice, so a `url ?? iri` fallback never " +
        "leaks the uncensored origin. A local non-wrapper post keeps its " +
        "own `/ap/…` IRI (it does not point outside this instance).",
      select: {
        columns: {
          id: true,
          iri: true,
          noteSourceId: true,
          type: true,
          censored: true,
          actorId: true,
          sharedPostId: true,
        },
        with: {
          actor: {
            columns: {
              accountId: true,
              suspended: true,
              suspendedUntil: true,
              handle: true,
            },
          },
          sharedPost: {
            columns: { censored: true, actorId: true },
            with: { actor: sanctionActorSelection },
          },
        },
      },
      resolve: (post, _, ctx) => {
        // A hidden post's own IRI (when remote) points at the uncensored
        // copy on its origin instance; a boost wrapper's `url` is already
        // nulled, so the `url ?? iri` fallback web-next uses for links would
        // leak through `iri`.  Mirror the `url` field: return the local
        // permalink, which renders the notice, for the same hidden
        // remote-or-wrapper case.  (A local non-wrapper post keeps its own
        // local `/ap/…` IRI, which never leaves this instance.)
        if (
          isCensoredForViewer(post, ctx) &&
          post.actor != null &&
          (post.sharedPostId != null || post.actor.accountId == null)
        ) {
          return new URL(
            `/${post.actor.handle}/${post.id}`,
            ctx.fedCtx.canonicalOrigin,
          );
        }
        if (post.type === "Question" && post.noteSourceId != null) {
          return ctx.fedCtx.getObjectUri(vocab.Question, {
            id: post.noteSourceId,
          });
        }
        return new URL(post.iri);
      },
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
    quotePolicy: t.field({
      type: QuotePolicy,
      select: {
        columns: { quotePolicy: true },
      },
      resolve(post) {
        return toQuotePolicy(post.quotePolicy);
      },
    }),
    quoteTargetState: t.field({
      type: QuoteTargetState,
      nullable: true,
      select: {
        columns: { quoteTargetState: true },
      },
      resolve(post) {
        return toQuoteTargetState(post.quoteTargetState);
      },
    }),
    censored: t.expose("censored", {
      type: "DateTime",
      nullable: true,
      description:
        "When a moderator censored this post, or `null` when it is not " +
        "censored.  Censored posts disappear from timelines, search, and " +
        "recommendations, but their permalinks stay reachable so a " +
        "censorship notice can be shown.  For everyone but the author " +
        "and moderators, all content-bearing fields are redacted: " +
        "`content`, the excerpt fields, `name`, `summary`, `hashtags`, " +
        "`Article.tags`, `media`, `link`, `mentions`, `sharedPost`, " +
        "`quotedPost`, article contents, and poll data.",
    }),
    name: t.field({
      type: "String",
      nullable: true,
      description: "The post's title. Non-null for `Article`s and local poll " +
        "`Question`s; `null` for `Note`s and boost wrappers.  `null` when " +
        "the post is censored or its author is hidden by a moderation " +
        "sanction (or it is a boost wrapper of such a post, whose title " +
        "it copies) and the viewer is neither the content's author nor " +
        "a moderator.",
      select: {
        columns: { name: true, censored: true, actorId: true },
        with: {
          actor: sanctionActorSelection,
          sharedPost: {
            columns: { censored: true, actorId: true },
            with: { actor: sanctionActorSelection },
          },
        },
      },
      resolve: (post, _, ctx) =>
        isCensoredForViewer(post, ctx) ? null : post.name,
    }),
    summary: t.field({
      type: "String",
      nullable: true,
      description:
        "Author-provided or LLM-generated summary of the post. `null` " +
        "when no summary has been set. For LLM summaries, check " +
        "`ArticleContent.summary` and `summaryStarted` instead, as those " +
        "are tracked per language on articles.  `null` when the post is " +
        "censored or its author is hidden by a moderation sanction (or it boosts such a post), and the viewer is " +
        "neither the content's author nor a moderator.",
      select: {
        columns: { summary: true, censored: true, actorId: true },
        with: {
          actor: sanctionActorSelection,
          sharedPost: {
            columns: { censored: true, actorId: true },
            with: { actor: sanctionActorSelection },
          },
        },
      },
      resolve: (post, _, ctx) =>
        isCensoredForViewer(post, ctx) ? null : post.summary,
    }),
    content: t.field({
      type: "HTML",
      description:
        "The post's full HTML content, with custom emoji shortcodes " +
        "rendered as `<img>` elements and external links annotated with " +
        '`target="_blank"`. Boost wrappers copy the boosted post\'s ' +
        "content; prefer `sharedPost.content`.  Empty when the post is " +
        "censored or its author is hidden by a moderation sanction (or it boosts such a post), and the viewer is " +
        "neither the content's author nor a moderator.",
      select: {
        columns: {
          actorId: true,
          censored: true,
          contentHtml: true,
          emojis: true,
          quotedPostId: true,
          tags: true,
        },
        with: {
          actor: sanctionActorSelection,
          mentions: {
            with: { actor: true },
          },
          sharedPost: {
            columns: { censored: true, actorId: true },
            with: { actor: sanctionActorSelection },
          },
        },
      },
      resolve: (post, _, ctx) => {
        if (isCensoredForViewer(post, ctx)) return "";
        let html = renderCustomEmojis(post.contentHtml, post.emojis);
        html = transformMentions(html, post.mentions, post.tags);
        html = addExternalLinkTargets(
          html,
          new URL(ctx.fedCtx.canonicalOrigin),
        );
        if (post.quotedPostId != null) html = removeQuoteInlineFallback(html);
        return html;
      },
    }),
    excerpt: t.string({
      description:
        "Plain-text excerpt of the post. Returns `summary` when set; " +
        "otherwise falls back to the HTML content stripped of tags. " +
        "For a truncated HTML preview, use `excerptHtml` instead.  " +
        "Empty when the post is censored or its author is hidden by a " +
        "moderation sanction (or it boosts such a post) " +
        "and the viewer is neither the content's author nor a moderator.",
      select: {
        columns: {
          actorId: true,
          censored: true,
          summary: true,
          contentHtml: true,
          quotedPostId: true,
        },
        with: {
          actor: sanctionActorSelection,
          sharedPost: {
            columns: { censored: true, actorId: true },
            with: { actor: sanctionActorSelection },
          },
        },
      },
      resolve(post, _, ctx) {
        if (isCensoredForViewer(post, ctx)) return "";
        if (post.summary != null) return post.summary;
        let html = post.contentHtml;
        if (post.quotedPostId != null) html = removeQuoteInlineFallback(html);
        return stripHtml(html);
      },
    }),
    excerptHtml: t.field({
      type: "HTML",
      description:
        "A sanitized, truncated HTML preview of this post's content, " +
        "clipped to roughly `maxChars` visible characters with valid tag " +
        "structure preserved. Use this on feed cards instead of `content` " +
        "to keep the rendered DOM small. Anchor tags are stripped — the " +
        "surrounding card is expected to be the link to the full post. " +
        "This does NOT fall back to `summary`; query `summary` separately " +
        "when you want to display a real (e.g. LLM-generated) summary " +
        "with its own affordances.  Empty when the post is censored or " +
        "its author is hidden by a moderation sanction (or it boosts " +
        "such a post) and the viewer is neither the " +
        "content's author nor a moderator.",
      args: {
        maxChars: t.arg.int({ required: true }),
      },
      select: {
        columns: {
          actorId: true,
          censored: true,
          contentHtml: true,
          emojis: true,
          quotedPostId: true,
        },
        with: {
          actor: sanctionActorSelection,
          sharedPost: {
            columns: { censored: true, actorId: true },
            with: { actor: sanctionActorSelection },
          },
        },
      },
      resolve(post, args, ctx) {
        if (isCensoredForViewer(post, ctx)) return "";
        // Remove quote-inline fallback first so the truncation budget isn't
        // wasted on text the user will never see.
        //
        // Sanitize BEFORE rendering custom emojis. The reverse order would
        // strip the inline `style` `renderCustomEmojis` puts on the emoji
        // `<img>` (which sets `height: 1em` and inline alignment), so emoji
        // images would render at their intrinsic size instead of inline with
        // the surrounding text. Emoji `src` is admin-uploaded and the alt is
        // bounded to `[a-z0-9_-]+` by `CUSTOM_EMOJI_REGEXP`, so the post-
        // sanitization injection doesn't open a new XSS surface.
        let html = post.contentHtml;
        if (post.quotedPostId != null) html = removeQuoteInlineFallback(html);
        return truncateHtml(
          renderCustomEmojis(sanitizeExcerptHtml(html), post.emojis),
          args.maxChars,
        );
      },
    }),
    language: t.exposeString("language", {
      nullable: true,
      description:
        "BCP 47 language tag of the post's primary content (e.g., `en`, " +
        "`ja`). `null` when the language is unknown or not specified by " +
        "the author.",
    }),
    hashtags: t.field({
      type: [Hashtag],
      description:
        "Hashtags mentioned in the post, extracted from the post's tag " +
        "map. Each entry includes the tag name and its canonical hashtag " +
        "search URL.  Empty when the post is censored or its author is " +
        "hidden by a moderation sanction (or it boosts such a post) and " +
        "the viewer is neither the content's author nor a moderator, " +
        "since hashtags are derived from the hidden " +
        "content.",
      select: {
        columns: { tags: true, censored: true, actorId: true },
        with: {
          actor: sanctionActorSelection,
          sharedPost: {
            columns: { censored: true, actorId: true },
            with: { actor: sanctionActorSelection },
          },
        },
      },
      resolve(post, _, ctx) {
        if (isCensoredForViewer(post, ctx)) return [];
        return Object.entries(post.tags).map(([name, href]) => ({
          name,
          href: new URL(href),
        }));
      },
    }),
    sensitive: t.exposeBoolean("sensitive", {
      description:
        "Whether the post is marked as sensitive (NSFW). Clients should " +
        "hide the content behind a content warning when this is `true`.",
    }),
    engagementStats: t.variant(PostEngagementStats),
    url: t.field({
      type: "URL",
      nullable: true,
      description:
        "The canonical, human-readable URL of this post. For source-backed " +
        "local posts the path encodes the local source identifier: " +
        "`Note.sourceId` for notes, `Article.publishedYear` + `Article.slug` " +
        "for articles, and `Question.sourceId` for questions. It does not " +
        "encode `Post.uuid`. For federated remote posts and " +
        "local share wrappers (boosts) this is whatever URL the originating " +
        "instance advertised (copied from the shared post in the boost case) " +
        "and is unrelated to the wrapper's own row PK. Prefer this field " +
        "over hand-building a path from `Post.uuid`: `uuid` is the row PK and " +
        "does not match the path here for source-backed local posts.  " +
        "`null` when the post is censored or its author is hidden by a " +
        "moderation sanction, and the viewer is neither the content's " +
        "author nor a moderator, EXCEPT for a local post (whose own " +
        "permalink renders the notice): a boost wrapper's URL mirrors the " +
        "boosted post's, and a remote post's URL points at the " +
        "uncensored copy on its origin instance, so both are hidden.",
      select: {
        columns: {
          url: true,
          censored: true,
          actorId: true,
          sharedPostId: true,
        },
        with: {
          actor: sanctionActorSelection,
          sharedPost: {
            columns: { censored: true, actorId: true },
            with: { actor: sanctionActorSelection },
          },
        },
      },
      resolve: (post, _, ctx) => {
        if (post.url == null) return null;
        // When the content is hidden, a boost wrapper's URL mirrors the
        // boosted post's, and a remote post's URL points at the
        // uncensored copy on its origin instance.  Only a local post's
        // own permalink leads to a page that renders the notice, so it
        // is the only URL kept.
        if (
          isCensoredForViewer(post, ctx) &&
          (post.sharedPostId != null || post.actor?.accountId == null)
        ) {
          return null;
        }
        return new URL(post.url);
      },
    }),
    updated: t.expose("updated", { type: "DateTime" }),
    published: t.expose("published", { type: "DateTime" }),
    actor: t.relation("actor", {
      description: "The actor who authored or boosted this post.",
    }),
    organizationAuthor: t.field({
      type: OrganizationPostAuthor,
      nullable: true,
      description:
        "Organization attribution metadata when this post was created " +
        "through an organization account. `null` for ordinary personal " +
        "posts and for federated posts without local organization metadata.",
      select: {
        with: { organizationAuthor: true },
      },
      resolve(post) {
        return post.organizationAuthor ?? null;
      },
    }),
    media: t.field({
      type: [PostMediumRef],
      description:
        "Media attachments on this post, in display order. For federated " +
        "posts the URLs point to the originating instance.  Empty when " +
        "the post is censored or its author is hidden by a moderation " +
        "sanction, and the viewer is neither the author nor a " +
        "moderator: attachments are part of the hidden content.",
      select: {
        columns: { censored: true, actorId: true },
        with: { actor: sanctionActorSelection, media: true },
      },
      resolve: (post, _, ctx) =>
        isCensoredForViewer(post, ctx) ? [] : post.media,
    }),
    link: t.field({
      type: PostLink,
      nullable: true,
      description:
        "OpenGraph / oEmbed preview for the first link in the post. " +
        "`null` when the post has no links or the metadata has not been " +
        "fetched yet, and also when the post is censored or its author " +
        "is hidden by a moderation sanction, and the viewer " +
        "is neither its author nor a moderator (the linked URL is part " +
        "of the censored content).",
      select: {
        columns: { censored: true, actorId: true },
        with: { actor: sanctionActorSelection, link: true },
      },
      resolve: (post, _, ctx) =>
        isCensoredForViewer(post, ctx) ? null : post.link,
    }),
    viewerHasShared: t.loadable({
      type: "Boolean",
      description:
        "Whether the selected viewer account has boosted this post. Always " +
        "`false` for unauthenticated requests. Pass `actingAccountId` for " +
        "an organization perspective.",
      args: {
        actingAccountId: t.arg.globalID({
          required: false,
          description: actingAccountIdArgDescription,
        }),
      },
      // cache: false so a mutation that flips share state in the same
      // request (e.g., share + read viewerHasShared) re-queries instead
      // of returning the pre-mutation value.
      loaderOptions: { cache: false },
      load: loadViewerHasShared,
      resolve: postViewerActorKey,
    }),
    viewerHasBookmarked: t.loadable({
      type: "Boolean",
      description:
        "Whether the authenticated viewer has bookmarked this post. " +
        "Always `false` for unauthenticated requests.",
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
      description:
        "Whether the authenticated viewer has pinned this post to their " +
        "profile. Always `false` for unauthenticated requests.",
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
    viewerCanReply: t.loadable({
      type: "Boolean",
      description:
        "Whether the selected viewer account is allowed to reply to this " +
        "post, based on visibility and block state. Always `false` for " +
        "unauthenticated requests. Pass `actingAccountId` for an " +
        "organization perspective.",
      args: {
        actingAccountId: t.arg.globalID({
          required: false,
          description: actingAccountIdArgDescription,
        }),
      },
      loaderOptions: { cache: false },
      load: async (
        keys: ViewerActorPostKey[],
        ctx: UserContext,
      ): Promise<boolean[]> => {
        const policies = await loadViewerActionPolicies(ctx, keys);
        return keys.map((key) =>
          policies.get(viewerActorPostKeyCacheKey(key))?.canReply ?? false
        );
      },
      resolve: postViewerActorKey,
    }),
    viewerCanQuote: t.loadable({
      type: "Boolean",
      description:
        "Whether the selected viewer account is allowed to quote this post, " +
        "based on `quotePolicy`, visibility, and block state. A censored " +
        "post cannot be quoted by anyone (including its author or a " +
        "moderator), so this is `false` for censored posts. Always `false` " +
        "for unauthenticated requests. Pass `actingAccountId` for an " +
        "organization perspective.",
      args: {
        actingAccountId: t.arg.globalID({
          required: false,
          description: actingAccountIdArgDescription,
        }),
      },
      loaderOptions: { cache: false },
      load: async (
        keys: ViewerActorPostKey[],
        ctx: UserContext,
      ): Promise<boolean[]> => {
        const policies = await loadViewerActionPolicies(ctx, keys);
        return keys.map((key) =>
          policies.get(viewerActorPostKeyCacheKey(key))?.canQuote ?? false
        );
      },
      resolve: postViewerActorKey,
    }),
    viewerCanRevokeQuote: t.boolean({
      description:
        "Whether the authenticated viewer (as the quoted post's author) " +
        "can revoke a quote of their post. `true` only when the viewer " +
        "is the author of `quotedPost` and the quoting post is either " +
        "local or has an authorization IRI. Pass `actingAccountId` for an " +
        "organization perspective.",
      args: {
        actingAccountId: t.arg.globalID({
          required: false,
          description: actingAccountIdArgDescription,
        }),
      },
      select: {
        columns: {
          id: true,
          quotedPostId: true,
          quoteAuthorizationIri: true,
        },
        with: {
          actor: {
            columns: { accountId: true },
          },
          quotedPost: {
            columns: { actorId: true },
          },
        },
      },
      async resolve(post, args, ctx) {
        const viewerActorId = await resolveViewerActorId(ctx, args);
        return viewerActorId != null && post.quotedPost != null &&
          post.quotedPost.actorId === viewerActorId &&
          (post.actor.accountId != null || post.quoteAuthorizationIri != null);
      },
    }),
    viewerCanShare: t.loadable({
      type: "Boolean",
      description:
        "Whether the selected viewer account is allowed to boost this post, " +
        "based on visibility and block state. A censored post cannot be " +
        "boosted by anyone (including its author or a moderator), so this " +
        "is `false` for censored posts. Always `false` for unauthenticated " +
        "requests. Pass `actingAccountId` for an organization perspective.",
      args: {
        actingAccountId: t.arg.globalID({
          required: false,
          description: actingAccountIdArgDescription,
        }),
      },
      loaderOptions: { cache: false },
      load: async (
        keys: ViewerActorPostKey[],
        ctx: UserContext,
      ): Promise<boolean[]> => {
        const policies = await loadViewerActionPolicies(ctx, keys);
        return keys.map((key) =>
          policies.get(viewerActorPostKeyCacheKey(key))?.canShare ?? false
        );
      },
      resolve: postViewerActorKey,
    }),
  }),
});

const DENY_ALL_POLICY: PostInteractionPolicy = {
  canReply: false,
  canQuote: false,
  canShare: false,
};

interface ViewerActorPostKey {
  postId: Uuid;
  viewerActorId: Uuid | null;
}

function viewerActorPostKeyCacheKey(key: ViewerActorPostKey): string {
  return `${key.viewerActorId ?? ""}:${key.postId}`;
}

async function postViewerActorKey(
  post: { id: Uuid },
  args: ActingAccountIdArg,
  ctx: UserContext,
): Promise<ViewerActorPostKey> {
  return {
    postId: post.id,
    viewerActorId: await resolveViewerActorId(ctx, args),
  };
}

async function loadViewerHasShared(
  keys: ViewerActorPostKey[],
  ctx: UserContext,
): Promise<boolean[]> {
  const postIdsByViewer = new Map<Uuid, Set<Uuid>>();
  for (const key of keys) {
    if (key.viewerActorId == null) continue;
    let postIds = postIdsByViewer.get(key.viewerActorId);
    if (postIds == null) {
      postIds = new Set();
      postIdsByViewer.set(key.viewerActorId, postIds);
    }
    postIds.add(key.postId);
  }

  const sharedKeys = new Set<string>();
  for (const [viewerActorId, postIds] of postIdsByViewer) {
    const rows = await ctx.db.select({ sharedPostId: postTable.sharedPostId })
      .from(postTable)
      .where(
        and(
          eq(postTable.actorId, viewerActorId),
          inArray(postTable.sharedPostId, [...postIds]),
        ),
      );
    for (const row of rows) {
      if (row.sharedPostId != null) {
        sharedKeys.add(`${viewerActorId}:${row.sharedPostId}`);
      }
    }
  }

  return keys.map((key) =>
    key.viewerActorId != null &&
    sharedKeys.has(`${key.viewerActorId}:${key.postId}`)
  );
}

async function loadViewerActionPolicies(
  ctx: UserContext,
  keys: readonly ViewerActorPostKey[],
): Promise<Map<string, PostInteractionPolicy>> {
  const cache = ctx.viewerActionPoliciesCache ??= new Map();
  // Dedupe missing ids so a batch with `cache: false` (which may surface
  // duplicate keys) cannot overwrite an already-registered promise — the
  // overwritten promise would still reject on a batch failure but be
  // un-awaited, producing an unhandled rejection.
  const missingByViewer = new Map<Uuid, Set<Uuid>>();
  for (const key of keys) {
    const cacheKey = viewerActorPostKeyCacheKey(key);
    if (cache.has(cacheKey)) continue;
    if (key.viewerActorId == null) {
      cache.set(cacheKey, Promise.resolve(DENY_ALL_POLICY));
      continue;
    }
    let missing = missingByViewer.get(key.viewerActorId);
    if (missing == null) {
      missing = new Set();
      missingByViewer.set(key.viewerActorId, missing);
    }
    missing.add(key.postId);
  }
  for (const [viewerActorId, missing] of missingByViewer) {
    // Kick off the batch lookup synchronously and register a derived promise
    // per post id before awaiting so that concurrent dispatch from the three
    // viewerCan* loaders deduplicates instead of each firing its own query.
    // Once the batch settles, drop the cached entries we registered so a
    // subsequent resolve pass (e.g., after a follow/block/visibility-changing
    // mutation in the same operation) re-queries and observes fresh state —
    // matching the `loaderOptions: { cache: false }` semantics on the
    // viewer-state fields.
    const missingIds = [...missing];
    const batch = getPostInteractionPolicies(
      ctx.db,
      missingIds,
      { id: viewerActorId } as schema.Actor,
    );
    const cleanup = () => {
      for (const id of missingIds) {
        cache.delete(viewerActorPostKeyCacheKey({
          postId: id,
          viewerActorId,
        }));
      }
    };
    batch.then(cleanup, cleanup);
    for (const id of missingIds) {
      const cacheKey = viewerActorPostKeyCacheKey({
        postId: id,
        viewerActorId,
      });
      cache.set(
        cacheKey,
        batch.then((policies) => policies.get(id) ?? DENY_ALL_POLICY),
      );
    }
  }
  const entries = await Promise.all(
    keys.map(async (key) => {
      const cacheKey = viewerActorPostKeyCacheKey(key);
      return [cacheKey, await cache.get(cacheKey)!] as const;
    }),
  );
  return new Map(entries);
}

function selectPostRelationWithActor(
  nestedSelection: () => unknown,
): Record<string, unknown> {
  const selection = nestedSelection();
  if (selection == null || typeof selection !== "object") {
    return { with: { actor: true } };
  }
  const withSelection = "with" in selection &&
      selection.with != null &&
      typeof selection.with === "object"
    ? selection.with as Record<string, unknown>
    : {};
  return {
    ...selection,
    with: {
      ...withSelection,
      actor: withSelection.actor ?? true,
    },
  };
}

export function hidePostRelationWithoutActor<T>(
  post: T | null | undefined,
): T | null {
  if (post == null || typeof post !== "object") return null;
  if (!("actor" in post) || post.actor == null) return null;
  return post;
}

builder.drizzleInterfaceFields(Post, (t) => ({
  sharedPost: t.field({
    type: Post,
    nullable: true,
    description:
      "The post being boosted. Non-null only for boost wrapper rows. " +
      "When this is non-null, `content` is empty and `url` mirrors the " +
      "shared post's URL.  `null` when the boost wrapper itself is " +
      "censored, or its author is hidden by a moderation sanction, and the viewer is neither the author nor a moderator: " +
      "what was boosted is the censored content.",
    select: (_, __, nestedSelection) => ({
      columns: { censored: true, actorId: true },
      with: {
        actor: sanctionActorSelection,
        sharedPost: selectPostRelationWithActor(nestedSelection),
      },
    }),
    // Timeline model helpers already sanitize nullable post relations whose
    // actor disappeared during Drizzle's multi-SELECT hydration, but Pothos
    // Drizzle can re-fetch these relations later while resolving nested
    // GraphQL fields.  If the related post row survives that re-fetch without
    // its required actor, hide the nullable relation instead of letting the
    // non-null `Post.actor` field fail the whole query.
    resolve: (post, _, ctx) =>
      isRowCensoredForViewer(post, ctx)
        ? null
        : hidePostRelationWithoutActor(post.sharedPost),
  }),
  replyTarget: t.field({
    type: Post,
    nullable: true,
    description:
      "The post this post is a reply to, or `null` for top-level posts.",
    select: (_, __, nestedSelection) => ({
      with: {
        replyTarget: selectPostRelationWithActor(nestedSelection),
      },
    }),
    resolve: (post) => hidePostRelationWithoutActor(post.replyTarget),
  }),
  quotedPost: t.field({
    type: Post,
    nullable: true,
    description:
      "The post being quoted inline. `null` for posts that are not " +
      "quotes, and also when the quoting post is censored or its author " +
      "is hidden by a moderation sanction, and the viewer " +
      "is neither its author nor a moderator: the quoted target is part " +
      "of the censored content.",
    select: (_, __, nestedSelection) => ({
      columns: { censored: true, actorId: true },
      with: {
        actor: sanctionActorSelection,
        quotedPost: selectPostRelationWithActor(nestedSelection),
      },
    }),
    resolve: (post, _, ctx) =>
      isCensoredForViewer(post, ctx)
        ? null
        : hidePostRelationWithoutActor(post.quotedPost),
  }),
  replies: t.relatedConnection("replies", {
    type: Post,
    description:
      "Posts that are direct replies to this post. Censored replies and " +
      "replies by actors whose content is hidden by a moderation sanction " +
      "are excluded.",
    query: (_, ctx) => ({
      where: {
        AND: [
          { actor: getSanctionVisibleActorFilter() },
          getCensoredPostExclusionFilter(ctx.account?.actor.id),
        ],
      },
    }),
  }),
  shares: t.relatedConnection("shares", {
    type: Post,
    description:
      "Boost wrapper posts that reshare this post. Each edge represents " +
      "a single boost by a specific actor. Censored boosts (including " +
      "boosts of a censored post) and boosts by actors whose content is " +
      "hidden by a moderation sanction are excluded.",
    query: (_, ctx) => ({
      where: {
        AND: [
          { actor: getSanctionVisibleActorFilter() },
          getCensoredPostExclusionFilter(ctx.account?.actor.id),
        ],
      },
    }),
  }),
  quotes: t.relatedConnection("quotes", {
    type: Post,
    description:
      "Posts that quote this post inline. Censored quotes and quotes by " +
      "actors whose content is hidden by a moderation sanction are " +
      "excluded.",
    query: (_, ctx) => ({
      where: {
        AND: [
          { actor: getSanctionVisibleActorFilter() },
          getCensoredPostExclusionFilter(ctx.account?.actor.id),
        ],
      },
    }),
  }),
  mentions: t.connection({
    type: Actor,
    description:
      "Actors explicitly @-mentioned in this post. Does not include " +
      "implicit mentions (e.g., the author of the post being replied to). " +
      "Empty when the post is censored or its author is hidden by a " +
      "moderation sanction, and the viewer is neither the " +
      "author nor a moderator, since the mention targets are part of the " +
      "censored content.",
    select: (args, ctx, nestedSelection) => ({
      columns: { censored: true, actorId: true },
      with: {
        actor: sanctionActorSelection,
        mentions: mentionConnectionHelpers.getQuery(args, ctx, nestedSelection),
      },
    }),
    resolve: (post, args, ctx) =>
      mentionConnectionHelpers.resolve(
        isCensoredForViewer(post, ctx) ? [] : post.mentions,
        args,
        ctx,
      ),
  }),
}));

export const Note = builder.drizzleNode("postTable", {
  variant: "Note",
  description:
    "A short-form microblog post, equivalent to a Mastodon Status or " +
    "ActivityPub Note. Notes can be composed locally or federated in from " +
    "remote instances. Boost wrappers (`sharedPost` is non-null) have empty " +
    "content and copy the shared post's URL.",
  interfaces: [Post, Reactable],
  id: {
    column: (post) => post.id,
  },
  fields: (t) => ({
    sourceId: t.expose("noteSourceId", {
      type: "UUID",
      nullable: true,
      description:
        "The local source UUID for this note — `noteSourceTable.id`, the " +
        "identifier embedded in `Post.url` (`/@username/<sourceId>`). " +
        "Non-null only for source-backed local notes (notes originally " +
        "composed on this instance). Null for federated remote notes and for " +
        "local share wrappers (boosts), since neither carries a " +
        "`noteSourceTable` row; for those, fall back to `Post.uuid`.",
    }),
    rawContent: t.field({
      type: "Markdown",
      nullable: true,
      description:
        "The raw Markdown source of this note. Non-null only when the " +
        "viewer is the note's author (i.e., the authenticated account " +
        "matches the note's `accountId`). Returns `null` for federated " +
        "remote notes, local share wrappers, and notes authored by " +
        "someone else.",
      select: {
        with: { noteSource: { columns: { content: true, accountId: true } } },
      },
      resolve: (post, _args, ctx) => {
        if (post.noteSource == null) return null;
        if (ctx.session?.accountId !== post.noteSource.accountId) return null;
        return post.noteSource.content;
      },
    }),
  }),
});

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
  description:
    "An unpublished article draft. Visible only to the owning account. " +
    "Drafts are promoted to `Article`s via the `publishArticleDraft` mutation.",
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
  description:
    "An ActivityPub `Question` poll. Local Questions are source-backed " +
    "short posts with immutable poll settings; remote Questions may have " +
    "`null` for `sourceId`. Use `Question.sourceId` for source-backed local " +
    "Question routes, and fall back to `Post.uuid` for federated remote " +
    "Questions and local share wrappers.",
  interfaces: [Post, Reactable],
  id: {
    column: (post) => post.id,
  },
  fields: (t) => ({
    sourceId: t.expose("noteSourceId", {
      type: "UUID",
      nullable: true,
      description:
        "The local source UUID for this question (`noteSourceTable.id`), " +
        "embedded in source-backed local Question URLs as " +
        "`/@username/<sourceId>`. `null` for federated remote questions and " +
        "local share wrappers; use `Post.uuid` as the fallback route token.",
    }),
  }),
});

/**
 * Whether this article content version belongs to a censored article whose
 * content must be redacted for the current viewer (the author and
 * moderators are exempt).  Guards direct `ArticleContent` node access,
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
      description: "The generated Open Graph preview image for this language " +
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

const Hashtag = builder.simpleObject("Hashtag", {
  fields: (t) => ({
    name: t.string(),
    href: t.field({ type: "URL" }),
  }),
});

const PostEngagementStats = builder.drizzleObject("postTable", {
  variant: "PostEngagementStats",
  description:
    "Cached engagement counters for a post. Updated asynchronously; may " +
    "be slightly stale. Query the live connections (`replies`, `shares`, " +
    "etc.) directly when exact real-time counts matter.",
  fields: (t) => ({
    replies: t.exposeInt("repliesCount"),
    shares: t.exposeInt("sharesCount"),
    quotes: t.exposeInt("quotesCount"),
    reactions: t.exposeInt("reactionsCount"),
    bookmarks: t.loadable({
      type: "Int",
      // cache: false so a mutation that flips bookmark state in the same
      // request (bookmark + read bookmarks + unbookmark + read bookmarks)
      // re-queries instead of returning the pre-mutation count.
      loaderOptions: { cache: false },
      load: async (postIds: Uuid[], ctx: UserContext): Promise<number[]> => {
        const counts = await getBookmarkCountsForPosts(ctx.db, postIds);
        return postIds.map((id) => counts.get(id) ?? 0);
      },
      resolve: (post) => post.id,
    }),
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

const PostMediumRef = builder.drizzleNode("postMediumTable", {
  name: "PostMedium",
  description:
    "A media attachment on a post. For local posts this refers to an " +
    "uploaded `Medium` stored on this instance; for federated posts the " +
    "`url` points to the remote media URL on the originating instance.  " +
    "Attachments of a censored post, or of a post whose author is hidden " +
    "by a moderation sanction, are part of the moderation-hidden content " +
    "and are only resolvable by the author and moderators, even through " +
    "direct `node(id:)` lookups.",
  authScopes: async (medium, ctx) => {
    const post = await ctx.db.query.postTable.findFirst({
      where: { id: medium.postId },
      columns: { censored: true, actorId: true },
      with: { actor: sanctionActorSelection },
    });
    if (
      post == null ||
      post.censored == null && !isActorSanctionHidden(post.actor)
    ) {
      return true;
    }
    if (ctx.account?.actor.id === post.actorId) return true;
    return { moderator: true };
  },
  runScopesOnType: true,
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
  description: "A stored media object (image). Two-step upload flow: call " +
    "`startMediumUpload` to get a pre-signed upload URL, PUT the image " +
    "to that URL, then call `finishMediumUpload` to complete the transaction. " +
    "Alternatively, call `createMedium` with a remote URL to import an " +
    "image directly. Unreferenced media older than the grace period are " +
    "deleted by the `deleteOrphanMedia` mutation.  Resolvable via " +
    "`node(id:)` when it has at least one reference visible to the viewer: " +
    "the avatar of an account that is not banned, or a published post that " +
    "is neither censored nor authored by a sanction-hidden actor (the " +
    "viewer's own account/posts and moderators always count as visible). " +
    "Hidden when it has references but every avatar and post reference is " +
    "moderation-hidden for the viewer; fresh, orphan, and draft-only media " +
    "(with no such references) remain resolvable.",
  authScopes: async (medium, ctx) => {
    if (ctx.account?.moderator) return true;
    const viewerActorId = ctx.account?.actor.id;
    // A medium stays resolvable when it has at least one reference visible
    // to this viewer: the avatar of a non-hidden account, or a published
    // post that is not censored and whose author is not sanction-hidden
    // (or that the viewer authored).  A freshly uploaded / orphan /
    // draft-only medium has no references and passes (preserving the
    // prior unscoped behavior); it is denied only when it has references
    // and every one of them is moderation-hidden for the viewer.
    const postSelection = {
      columns: { censored: true, actorId: true },
      with: {
        actor: {
          columns: {
            accountId: true,
            suspended: true,
            suspendedUntil: true,
          },
        },
      },
    } as const;
    const avatarAccounts = await ctx.db.query.accountTable.findMany({
      where: { avatarMediumId: medium.id },
      columns: { id: true },
      with: {
        actor: {
          columns: { id: true, suspended: true, suspendedUntil: true },
        },
      },
    });
    for (const account of avatarAccounts) {
      if (account.actor == null || !isActorProfileHidden(account.actor, ctx)) {
        return true;
      }
    }
    const noteMedia = await ctx.db.query.noteSourceMediumTable.findMany({
      where: { mediumId: medium.id },
      columns: { sourceId: true },
      with: {
        source: { columns: { id: true }, with: { post: postSelection } },
      },
    });
    for (const { source } of noteMedia) {
      const post = source?.post;
      if (
        post != null &&
        (post.actorId === viewerActorId ||
          (post.censored == null && !isActorSanctionHidden(post.actor)))
      ) {
        return true;
      }
    }
    const articleMedia = await ctx.db.query.articleSourceMediumTable.findMany({
      where: { mediumId: medium.id },
      columns: { articleSourceId: true },
      with: {
        articleSource: {
          columns: { id: true },
          with: { post: postSelection },
        },
      },
    });
    for (const { articleSource } of articleMedia) {
      const post = articleSource?.post;
      if (
        post != null &&
        (post.actorId === viewerActorId ||
          (post.censored == null && !isActorSanctionHidden(post.actor)))
      ) {
        return true;
      }
    }
    const hasReference = avatarAccounts.length > 0 ||
      noteMedia.length > 0 || articleMedia.length > 0;
    return !hasReference;
  },
  // Run the scope when the node itself is resolved, so a cached avatar
  // medium id cannot bypass the redacted Account.avatarMediumId.
  runScopesOnType: true,
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

export const PostLink = builder.drizzleNode("postLinkTable", {
  variant: "PostLink",
  description: "OpenGraph / oEmbed metadata for a link embedded in a post. " +
    "Populated asynchronously after the post is created; individual " +
    "fields may be `null` until the metadata fetch completes or if the " +
    "linked page does not expose the corresponding tag.  Not resolvable " +
    "via `node(id:)` when every post referencing the link is censored or " +
    "authored by a sanction-hidden actor, for this viewer: the linked " +
    "URL is part of the moderation-hidden content.",
  authScopes: (link, ctx) => {
    if (ctx.account?.moderator) return true;
    // Link rows are shared across posts referencing the same URL, so the
    // link counts as hidden only when no referencing post still shows it
    // to this viewer: a referencing post must be uncensored AND have a
    // sanction-visible author (the same rule post visibility applies),
    // or be the viewer's own.  Orphan rows with no referencing post
    // (e.g. news-only links) pass.  Batched through a request-scoped
    // loader so link-heavy pages (the news list) stay free of per-link
    // lookups.
    ctx.postLinkVisibleLoader ??= new DataLoader<Uuid, boolean>(
      async (linkIds) => {
        const ids = [...linkIds];
        const viewerActorId = ctx.account?.actor.id;
        // Bind the sanction-activeness comparison to a request-time `Date`,
        // the same application clock the write path and `isActorSanctionHidden`
        // use, NOT SQL `now()`: inside a transaction `now()` is frozen at the
        // transaction start, so a ban recorded later (with `new Date()`) would
        // read as not-yet-active and leak the hidden link.
        const now = new Date();
        // NULL-safe mirror of isActorSanctionHidden's complement, built with
        // drizzle operators so the `now` Date binds as a parameter (a remote
        // actor's content is hidden by an active federation block; a local
        // actor's only by a permanent ban).  `lte`/`gt` on a `null`
        // `suspendedUntil` yield `null` (not matched), which is the intended
        // NULL-safe behavior.
        const shows = and(
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
        )!;
        const visible = await ctx.db
          .selectDistinct({ linkId: postTable.linkId })
          .from(postTable)
          .innerJoin(actorTable, eq(postTable.actorId, actorTable.id))
          .where(and(
            inArray(postTable.linkId, ids),
            viewerActorId == null
              ? shows
              : or(eq(postTable.actorId, viewerActorId), shows),
          ));
        const visibleSet = new Set(visible.map((row) => row.linkId));
        if (visibleSet.size === ids.length) return ids.map(() => true);
        const referenced = await ctx.db
          .selectDistinct({ linkId: postTable.linkId })
          .from(postTable)
          .where(inArray(postTable.linkId, ids));
        const referencedSet = new Set(referenced.map((row) => row.linkId));
        return ids.map((id) => visibleSet.has(id) || !referencedSet.has(id));
      },
    );
    return ctx.postLinkVisibleLoader.load(link.id);
  },
  // Run the scope when the node itself is resolved, so a cached link
  // node id cannot bypass the Post.link redaction via node(id:).
  runScopesOnType: true,
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

const CreateQuestionPollInput = builder.inputType("CreateQuestionPollInput", {
  description:
    "Immutable poll settings for `createQuestion`. These settings cannot " +
    "be edited after the Question is published.",
  fields: (t) => ({
    title: t.string({
      required: true,
      description:
        "Poll title used as the ActivityPub `Question.name`. Must be " +
        "between `1` and `200` characters after trimming.",
    }),
    multiple: t.boolean({
      required: true,
      description:
        "Whether voters may choose more than one option. `false` creates " +
        "an ActivityPub Question with exclusive options.",
    }),
    options: t.stringList({
      required: true,
      description:
        "Poll option labels in display order. Must contain between `2` " +
        "and `20` unique, non-empty entries after trimming.",
    }),
    ends: t.field({
      type: "DateTime",
      required: true,
      description:
        "Voting deadline. Must be at least `1` minute and at most `1` " +
        "year in the future.",
    }),
  }),
});

builder.relayMutationField(
  "createNote",
  {
    description:
      "Publish a new short-form note. Sends an ActivityPub `Create` " +
      "activity to relevant inboxes based on `visibility`. Requires " +
      "authentication.",
    inputFields: (t) => ({
      visibility: t.field({ type: PostVisibility, required: true }),
      content: t.field({ type: "Markdown", required: true }),
      language: t.field({ type: "Locale", required: true }),
      quotePolicy: t.field({ type: QuotePolicy, required: false }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to publish as. Omit to publish as the " +
          "authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to publish as that " +
          "organization.",
      }),
      attributionMode: t.field({
        type: PostAttributionMode,
        required: false,
        description:
          "How to display the personal member when `actingAccountId` is " +
          "an organization. Defaults to `ACTING_ACCOUNT_ONLY`; invalid " +
          "when publishing as a personal account.",
      }),
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
        ActorSuspendedError,
        OrganizationPermissionError,
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
        quotePolicy,
        media,
        replyTargetId,
        quotedPostId,
      } = args.input;
      const actingAccount = await resolvePostActingAccount(ctx, args.input);
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
                followers: {
                  where: { followerId: actingAccount.account.actor.id },
                },
                blockees: {
                  where: { blockeeId: actingAccount.account.actor.id },
                },
                blockers: {
                  where: { blockerId: actingAccount.account.actor.id },
                },
              },
            },
            mentions: { where: { actorId: actingAccount.account.actor.id } },
          },
          where: { id: replyTargetId.id },
        });
        if (
          post == null || !isPostVisibleTo(post, actingAccount.account.actor)
        ) {
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
                followers: {
                  where: { followerId: actingAccount.account.actor.id },
                },
                blockees: {
                  where: { blockeeId: actingAccount.account.actor.id },
                },
                blockers: {
                  where: { blockerId: actingAccount.account.actor.id },
                },
              },
            },
            mentions: { where: { actorId: actingAccount.account.actor.id } },
            sharedPost: {
              with: {
                actor: {
                  with: {
                    followers: {
                      where: { followerId: actingAccount.account.actor.id },
                    },
                    blockees: {
                      where: { blockeeId: actingAccount.account.actor.id },
                    },
                    blockers: {
                      where: { blockerId: actingAccount.account.actor.id },
                    },
                  },
                },
                mentions: {
                  where: { actorId: actingAccount.account.actor.id },
                },
              },
            },
          },
          where: { id: quotedPostId.id },
        });
        if (
          post == null || !isPostVisibleTo(post, actingAccount.account.actor)
        ) {
          throw new InvalidInputError("quotedPostId");
        }
        // Validate against the effective original post to prevent bypassing
        // via a public share wrapper of a non-quotable original.
        const effectivePost = post.sharedPost ?? post;
        if (effectivePost.sharedPostId != null) {
          throw new InvalidInputError("quotedPostId");
        }
        if (!isPostVisibleTo(effectivePost, actingAccount.account.actor)) {
          throw new InvalidInputError("quotedPostId");
        }
        // Neither a censored post nor a censored share wrapper can be
        // quoted; the model revalidates, but the submitted row is
        // unwrapped here, so the wrapper must be checked here too.
        if (post.censored != null || effectivePost.censored != null) {
          throw new InvalidInputError("quotedPostId");
        }
        if (
          !canActorRequestQuotePost(effectivePost, actingAccount.account.actor)
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
        let note: Awaited<ReturnType<typeof createNote>>;
        try {
          note = await createNote(
            context,
            {
              accountId: actingAccount.account.id,
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
              quotePolicy: normalizeQuotePolicyForVisibility(
                visibility === "PUBLIC"
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
                quotePolicy == null ? undefined : fromQuotePolicy(quotePolicy),
              ),
              content,
              language: language.baseName,
              media: noteMedia,
            },
            { replyTarget, quotedPost },
            {
              afterPostCreated: (post, db) =>
                recordPostActingAccount(db, post.id, actingAccount),
            },
          );
        } catch (error) {
          if (error instanceof QuotePolicyDeniedError) {
            throw new InvalidInputError("quotedPostId");
          }
          throw error;
        }
        if (note == null) {
          throw createGraphQLError("Failed to create note.", {
            originalError: new Error("Failed to create note."),
            extensions: { code: "INTERNAL_SERVER_ERROR" },
          });
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
  "createQuestion",
  {
    description:
      "Publish a new short-form post with an immutable ActivityPub " +
      "`Question` poll. Sends an ActivityPub `Create` activity to relevant " +
      "inboxes based on `visibility`. Requires authentication.",
    inputFields: (t) => ({
      visibility: t.field({
        type: PostVisibility,
        required: true,
        description: "Audience for the new Question post.",
      }),
      content: t.field({
        type: "Markdown",
        required: true,
        description:
          "Markdown body shown above the poll. The body remains editable " +
          "only through future note-editing support; poll settings are " +
          "immutable.",
      }),
      language: t.field({
        type: "Locale",
        required: true,
        description: "BCP 47 language tag for the Question body.",
      }),
      quotePolicy: t.field({
        type: QuotePolicy,
        required: false,
        description:
          "Who may quote this Question. Omit to use the default policy for " +
          "the selected `visibility`.",
      }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to publish as. Omit to publish as the " +
          "authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to publish as that " +
          "organization.",
      }),
      attributionMode: t.field({
        type: PostAttributionMode,
        required: false,
        description:
          "How to display the personal member when `actingAccountId` is " +
          "an organization. Defaults to `ACTING_ACCOUNT_ONLY`; invalid " +
          "when publishing as a personal account.",
      }),
      poll: t.field({
        type: CreateQuestionPollInput,
        required: true,
        description:
          "Poll title, options, selection mode, and deadline. These values " +
          "cannot be changed after publishing.",
      }),
      media: t.field({
        type: [CreateNoteMediumInput],
        required: false,
        defaultValue: [],
        description: "Media to attach to the Question body, in display order.",
      }),
      replyTargetId: t.globalID({
        for: [Note, Article, Question],
        required: false,
        description:
          "Optional post to reply to. The target must be visible to the " +
          "authenticated account.",
      }),
      quotedPostId: t.globalID({
        for: [Note, Article, Question],
        required: false,
        description:
          "Optional post to quote. Share wrappers are resolved to their " +
          "original post before quote policy checks.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
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
        quotePolicy,
        poll,
        media,
        replyTargetId,
        quotedPostId,
      } = args.input;
      const actingAccount = await resolvePostActingAccount(ctx, args.input);
      const attachedMedia = media ?? [];
      if (attachedMedia.length > 20) {
        throw new InvalidInputError("media");
      }
      if (visibility === "NONE") {
        throw new InvalidInputError("visibility");
      }
      let replyTarget: schema.Post & { actor: schema.Actor } | undefined;
      if (replyTargetId != null) {
        const post = await ctx.db.query.postTable.findFirst({
          with: {
            actor: {
              with: {
                followers: {
                  where: { followerId: actingAccount.account.actor.id },
                },
                blockees: {
                  where: { blockeeId: actingAccount.account.actor.id },
                },
                blockers: {
                  where: { blockerId: actingAccount.account.actor.id },
                },
              },
            },
            mentions: { where: { actorId: actingAccount.account.actor.id } },
          },
          where: { id: replyTargetId.id },
        });
        if (
          post == null || !isPostVisibleTo(post, actingAccount.account.actor)
        ) {
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
                followers: {
                  where: { followerId: actingAccount.account.actor.id },
                },
                blockees: {
                  where: { blockeeId: actingAccount.account.actor.id },
                },
                blockers: {
                  where: { blockerId: actingAccount.account.actor.id },
                },
              },
            },
            mentions: { where: { actorId: actingAccount.account.actor.id } },
            sharedPost: {
              with: {
                actor: {
                  with: {
                    followers: {
                      where: { followerId: actingAccount.account.actor.id },
                    },
                    blockees: {
                      where: { blockeeId: actingAccount.account.actor.id },
                    },
                    blockers: {
                      where: { blockerId: actingAccount.account.actor.id },
                    },
                  },
                },
                mentions: {
                  where: { actorId: actingAccount.account.actor.id },
                },
              },
            },
          },
          where: { id: quotedPostId.id },
        });
        if (
          post == null || !isPostVisibleTo(post, actingAccount.account.actor)
        ) {
          throw new InvalidInputError("quotedPostId");
        }
        const effectivePost = post.sharedPost ?? post;
        if (effectivePost.sharedPostId != null) {
          throw new InvalidInputError("quotedPostId");
        }
        if (!isPostVisibleTo(effectivePost, actingAccount.account.actor)) {
          throw new InvalidInputError("quotedPostId");
        }
        // Neither a censored post nor a censored share wrapper can be
        // quoted; the model revalidates, but the submitted row is
        // unwrapped here, so the wrapper must be checked here too.
        if (post.censored != null || effectivePost.censored != null) {
          throw new InvalidInputError("quotedPostId");
        }
        if (
          !canActorRequestQuotePost(effectivePost, actingAccount.account.actor)
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
        const modelVisibility = visibility === "PUBLIC"
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
          );
        let question: Awaited<ReturnType<typeof createQuestion>>;
        try {
          question = await createQuestion(
            context,
            {
              accountId: actingAccount.account.id,
              visibility: modelVisibility,
              quotePolicy: normalizeQuotePolicyForVisibility(
                modelVisibility,
                quotePolicy == null ? undefined : fromQuotePolicy(quotePolicy),
              ),
              content,
              language: language.baseName,
              media: noteMedia,
              poll: {
                title: poll.title,
                multiple: poll.multiple,
                options: poll.options,
                ends: poll.ends,
              },
            },
            { replyTarget, quotedPost },
            {
              afterPostCreated: (post, db) =>
                recordPostActingAccount(db, post.id, actingAccount),
            },
          );
        } catch (error) {
          if (error instanceof QuotePolicyDeniedError) {
            throw new InvalidInputError("quotedPostId");
          }
          if (error instanceof InvalidPollInputError) {
            throw new InvalidInputError(error.inputPath);
          }
          throw error;
        }
        if (question == null) {
          throw createGraphQLError("Failed to create question.", {
            originalError: new Error("Failed to create question."),
            extensions: { code: "INTERNAL_SERVER_ERROR" },
          });
        }
        return question;
      });
    },
  },
  {
    outputFields: (t) => ({
      question: t.field({
        type: Question,
        description: "The newly published `Question` post.",
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "updateNote",
  {
    description:
      "Edit the content, language, or quote policy of an existing local " +
      "note. Visibility cannot be changed after creation. Only the note's " +
      "author may call this. Pass `actingAccountId` when editing a note " +
      "authored by an organization account you belong to. Sends an " +
      "ActivityPub `Update` activity to the appropriate recipients. " +
      "Requires authentication.",
    inputFields: (t) => ({
      noteId: t.globalID({
        for: [Note],
        required: true,
        description: "Global ID of the note to update.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
      content: t.field({
        type: "Markdown",
        required: false,
        description: "New Markdown body. Omit to keep the existing content.",
      }),
      language: t.field({
        type: "Locale",
        required: false,
        description: "New language. Omit to keep the existing language.",
      }),
      quotePolicy: t.field({
        type: QuotePolicy,
        required: false,
        description: "New quote policy. Omit to keep the existing policy.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: args.input.noteId.id },
        with: { noteSource: true },
      });
      if (post?.noteSource == null) throw new InvalidInputError("noteId");
      await resolvePostManagementActingAccount(
        ctx,
        args.input,
        post.noteSource.accountId,
        "noteId",
      );

      const patch = {
        ...(args.input.content != null ? { content: args.input.content } : {}),
        ...(args.input.language != null
          ? { language: args.input.language.baseName }
          : {}),
        ...(args.input.quotePolicy != null
          ? { quotePolicy: fromQuotePolicy(args.input.quotePolicy) }
          : {}),
      };
      if (Object.keys(patch).length === 0) {
        throw new InvalidInputError("input");
      }
      const updated = await updateNote(ctx.fedCtx, post.noteSource.id, patch);
      if (updated == null) throw new InvalidInputError("noteId");
      return updated;
    },
  },
  {
    outputFields: (t) => ({
      note: t.field({
        type: Note,
        description: "The note after the update has been applied.",
        resolve: (post) => post,
      }),
    }),
  },
);

builder.relayMutationField(
  "saveArticleDraft",
  {
    description:
      "Create or update an article draft. Omit `id` to create a new draft. " +
      "Requires authentication.",
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
    description:
      "Permanently delete an article draft. Only the draft's owner may " +
      "delete it. Requires authentication.",
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
    description: "Delete a post and send an ActivityPub `Delete` activity to " +
      "federated instances. Boost wrappers cannot be deleted this way; " +
      "use `unsharePost` instead (returns `SharedPostDeletionNotAllowedError`). " +
      "Pass `actingAccountId` to delete a post authored by an organization " +
      "account you belong to.",
    inputFields: (t) => ({
      id: t.globalID({
        for: [Note, Article, Question],
        required: true,
        description: "Global ID of the post to delete.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        SharedPostDeletionNotAllowedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const post = await ctx.db.query.postTable.findFirst({
        with: { actor: true, replyTarget: true },
        where: { id: args.input.id.id },
      });

      if (post == null || post.actor.accountId == null) {
        throw new InvalidInputError("id");
      }
      await resolvePostManagementActingAccount(
        ctx,
        args.input,
        post.actor.accountId,
        "id",
      );

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
  "revokeQuote",
  {
    description:
      "As the quoted post's author, revoke permission for a quote of " +
      "your post. Sends a revocation activity to the quoting instance. " +
      "Only the `quotedPost`'s author may call this. Pass `actingAccountId` " +
      "when the quoted post was authored by an organization account you " +
      "belong to.",
    inputFields: (t) => ({
      quotePostId: t.globalID({
        for: [Note, Article, Question],
        required: true,
        description: "Global ID of the quote post to revoke.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );
      const quote = await ctx.db.query.postTable.findFirst({
        with: {
          actor: true,
          quotedPost: true,
        },
        where: { id: args.input.quotePostId.id },
      });
      if (quote?.quotedPost == null) {
        throw new InvalidInputError("quotePostId");
      }
      if (quote.quotedPost.actorId !== actingAccount.actor.id) {
        throw new InvalidInputError("quotePostId");
      }
      if (
        quote.actor.accountId == null && quote.quoteAuthorizationIri == null
      ) {
        throw new InvalidInputError("quotePostId");
      }
      const updatedQuote = await withTransaction(
        ctx.fedCtx,
        async (context) =>
          await revokeQuoteModel(
            context,
            actingAccount,
            quote,
            quote.quotedPost!,
          ),
      );
      const quotedPost = await ctx.db.query.postTable.findFirst({
        where: { id: quote.quotedPost.id },
      });
      if (quotedPost == null) throw new InvalidInputError("quotePostId");
      return { quote: updatedQuote, quotedPost };
    },
  },
  {
    outputFields: (t) => ({
      quote: t.field({
        type: Post,
        resolve(result) {
          return result.quote;
        },
      }),
      quotedPost: t.field({
        type: Post,
        resolve(result) {
          return result.quotedPost;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "publishArticleDraft",
  {
    description:
      "Publish an article draft, converting it to a live `Article` post " +
      "and deleting the draft. Sends an ActivityPub `Create` activity. " +
      "Requires authentication.",
    inputFields: (t) => ({
      id: t.globalID({ for: [ArticleDraft], required: true }),
      slug: t.string({ required: true }),
      language: t.field({ type: "Locale", required: true }),
      allowLlmTranslation: t.boolean({ required: false }),
      quotePolicy: t.field({ type: QuotePolicy, required: false }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to publish as. The draft must still be " +
          "owned by the authenticated personal account; this only changes " +
          "the published article's author.",
      }),
      attributionMode: t.field({
        type: PostAttributionMode,
        required: false,
        description:
          "How to display the personal member when `actingAccountId` is " +
          "an organization. Defaults to `ACTING_ACCOUNT_ONLY`; invalid " +
          "when publishing as a personal account.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      const actingAccount = await resolvePostActingAccount(ctx, args.input);

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

      const { slug, language, allowLlmTranslation, quotePolicy } = args.input;

      // Create article from draft
      const article = await withTransaction(ctx.fedCtx, async (context) => {
        const media = await context.data.db.query.articleDraftMediumTable
          .findMany({
            where: { articleDraftId: draft.id },
          });
        const created = await createArticle(context, {
          accountId: actingAccount.account.id,
          publishedYear: new Date().getFullYear(),
          slug,
          tags: draft.tags,
          allowLlmTranslation: allowLlmTranslation ?? true,
          quotePolicy: quotePolicy == null
            ? "everyone"
            : fromQuotePolicy(quotePolicy),
          title: draft.title,
          content: draft.content,
          language: language.baseName,
          media,
        }, {
          afterPostCreated: (post, db) =>
            recordPostActingAccount(db, post.id, actingAccount),
        });
        return created;
      });

      if (!article) {
        throw createGraphQLError("Failed to publish article.", {
          originalError: new Error("Failed to publish article."),
          extensions: { code: "INTERNAL_SERVER_ERROR" },
        });
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
    description:
      "Add an emoji reaction to a post. Sends an ActivityPub `Like` " +
      "or `EmojiReact` activity. Idempotent: adding the same emoji twice " +
      "has no effect. Exactly one of `emoji` or `customEmojiId` must be " +
      "provided. Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to react as. Omit to react as the " +
          "authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to react as that " +
          "organization.",
      }),
      emoji: t.string({ required: false }),
      customEmojiId: t.globalID({ for: CustomEmoji, required: false }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const { postId, emoji, customEmojiId } = args.input;

      if (emoji == null && customEmojiId == null) {
        throw new InvalidInputError("emoji");
      }
      if (emoji != null && customEmojiId != null) {
        throw new InvalidInputError("emoji");
      }
      if (emoji != null && !isReactionEmoji(emoji)) {
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
          // Load the boosted post's author so a wrapper of a sanction-hidden
          // actor's post is correctly hidden by isPostVisibleTo (which now
          // fails closed when a wrapper's sharedPost is not loaded).
          sharedPost: { with: { actor: true } },
          mentions: true,
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, actingAccount.actor)) {
        throw new InvalidInputError("postId");
      }

      const reaction = await react(
        ctx.fedCtx,
        actingAccount,
        post,
        emoji as ReactionEmoji | null ?? null,
        customEmojiId?.id as Uuid | undefined,
      );

      if (reaction != null) {
        return reaction;
      }

      const existingReaction = await ctx.db.query.reactionTable.findFirst({
        where: emoji != null
          ? { postId: post.id, actorId: actingAccount.actor.id, emoji }
          : {
            postId: post.id,
            actorId: actingAccount.actor.id,
            customEmojiId: customEmojiId!.id as Uuid,
          },
      });

      if (existingReaction != null) {
        return existingReaction;
      }

      throw createGraphQLError("Failed to react to the post.", {
        originalError: new Error("Failed to react to the post."),
        extensions: { code: "INTERNAL_SERVER_ERROR" },
      });
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
    description:
      "Remove an emoji reaction from a post. Sends an ActivityPub `Undo " +
      "Like` activity. Idempotent: removing a reaction that doesn't exist " +
      "returns `success: true`. Exactly one of `emoji` or `customEmojiId` " +
      "must be provided. Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to remove the reaction as. Omit to use " +
          "the authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to remove that " +
          "organization's reaction.",
      }),
      emoji: t.string({ required: false }),
      customEmojiId: t.globalID({ for: CustomEmoji, required: false }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const { postId, emoji, customEmojiId } = args.input;

      if (emoji == null && customEmojiId == null) {
        throw new InvalidInputError("emoji");
      }
      if (emoji != null && customEmojiId != null) {
        throw new InvalidInputError("emoji");
      }
      if (emoji != null && !isReactionEmoji(emoji)) {
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
          // A boost shows the wrapper id, so undoing a reaction on it must
          // hydrate sharedPost: isPostVisibleTo() fails closed on a wrapper
          // whose boosted post was not loaded.
          sharedPost: { with: { actor: true } },
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, actingAccount.actor)) {
        throw new InvalidInputError("postId");
      }

      await undoReaction(
        ctx.fedCtx,
        actingAccount,
        post,
        emoji as ReactionEmoji | null ?? null,
        customEmojiId?.id as Uuid | undefined,
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
    description:
      "Boost (reshare) a post by creating a share wrapper post and " +
      "sending an ActivityPub `Announce` activity. Returns the wrapper " +
      "post as `share` and the original post as `originalPost`. " +
      "Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to boost as. Omit to boost as the " +
          "authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to boost as that " +
          "organization.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

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

      if (!isPostVisibleTo(post, actingAccount.actor)) {
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
      if (!isPostVisibleTo(effectivePost, actingAccount.actor)) {
        throw new InvalidInputError("postId");
      }
      // A censored post cannot be boosted (by anyone, including its
      // author): the wrapper would copy the censored content and
      // federate an `Announce` re-amplifying moderation-hidden content.
      if (post.censored != null || effectivePost.censored != null) {
        throw new InvalidInputError("postId");
      }
      if (
        effectivePost.visibility !== "public" &&
        effectivePost.visibility !== "unlisted" &&
        !(effectivePost.visibility === "followers" &&
          effectivePost.actorId === actingAccount.actor.id)
      ) {
        throw new InvalidInputError("postId");
      }

      const share = await sharePost(
        ctx.fedCtx,
        actingAccount,
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
    description:
      "Undo a boost by deleting the share wrapper post and sending an " +
      "ActivityPub `Undo Announce` activity. Pass the original post's " +
      "`id` (not the wrapper's). Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to undo a boost as. Omit to use the " +
          "authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to remove that " +
          "organization's boost.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

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
          // Hydrate sharedPost so a boost wrapper passed by id is judged by
          // isPostVisibleTo() instead of failing closed on the unloaded
          // boosted post.
          sharedPost: { with: { actor: true } },
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, actingAccount.actor)) {
        throw new InvalidInputError("postId");
      }

      const unshared = await unsharePost(
        ctx.fedCtx,
        actingAccount,
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
    description:
      "Save a post to the viewer's bookmarks. Bookmarks are private and " +
      "not federated. Idempotent. Requires authentication.",
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
          // A boost shows the wrapper id, so bookmarking one must hydrate
          // sharedPost: isPostVisibleTo() fails closed on a wrapper whose
          // boosted post was not loaded.
          sharedPost: { with: { actor: true } },
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
    description:
      "Remove a post from the viewer's bookmarks. Idempotent. Requires authentication.",
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
    description:
      "Pin a post to the top of the viewer's profile. Only the post's " +
      "author may pin it. Pass `actingAccountId` to pin an organization " +
      "post to that organization's profile. Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
        description: "Global ID of the post to pin.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      const pin = await pinPostModel(ctx.fedCtx, actingAccount.actor, post);
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
    description:
      "Remove a pin from the viewer's profile. Pass `actingAccountId` to " +
      "remove a pin from an organization profile. Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
        description: "Global ID of the post to unpin.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      const pin = await unpinPostModel(ctx.fedCtx, actingAccount.actor, post);
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
    description: "Look up an article draft by its global `id` or its `uuid`. " +
      "Requires authentication; only returns drafts owned by the " +
      "authenticated viewer.",
    args: {
      id: t.arg.globalID({ for: [ArticleDraft], required: false }),
      uuid: t.arg({ type: "UUID", required: false }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) return null;

      // At least one of id or uuid must be provided
      if (!args.id && !args.uuid) {
        throw createGraphQLError("Either id or uuid must be provided.", {
          extensions: { code: "BAD_USER_INPUT" },
        });
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
    description:
      "Resolve a post by its URL, fetching it from the originating " +
      "instance via ActivityPub if it is not already cached. Requires " +
      "authentication (unauthenticated callers always receive `null`). " +
      "Returns `null` if the post is not found or not visible to the viewer.",
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
        // A boost URL resolves to the wrapper, so hydrate sharedPost:
        // isPostVisibleTo() fails closed on a wrapper whose boosted post was
        // not loaded (and this keeps a boost of a sanction-hidden author
        // hidden here too).
        sharedPost: { with: { actor: true } },
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
    description: "Look up a locally-authored article by the author's handle, " +
      "publication year, and URL slug. This is the resolver for the " +
      "canonical article permalink path `/@{handle}/{year}/{slug}`.",
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
    description:
      "Edit an existing article's content, title, or tags. Only the " +
      "article's author may update it. Sends an ActivityPub `Update` " +
      "activity. Pass `actingAccountId` when updating an article authored " +
      "by an organization account you belong to. Requires authentication.",
    inputFields: (t) => ({
      articleId: t.globalID({
        for: [Article],
        required: true,
        description: "Global ID of the article to update.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
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
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
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

      await resolvePostManagementActingAccount(
        ctx,
        args.input,
        post.articleSource.accountId,
        "articleId",
      );

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
    description:
      "Request an LLM translation of an article into the given target " +
      "language. Returns immediately; the translated `ArticleContent` " +
      "appears asynchronously (check `beingTranslated`). Returns " +
      "`LlmTranslationNotAllowedError` if translation is disabled on " +
      "the article or the target language matches the source language.",
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
    description:
      "Import a media object from a remote URL and store it locally. " +
      "Use this instead of the two-step `startMediumUpload` / " +
      "`finishMediumUpload` flow when the image is already accessible " +
      "via URL. Requires authentication.",
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
      // Record the importing account as the medium owner during the upload
      // window. Without this, content-hash deduplication can return a row
      // owned by another account, and downstream owner-gated operations
      // (e.g. `attachArticleSourceMedium`) would then reject this user
      // even though they performed the import themselves. Mirrors the
      // ownership marker that `finishMediumUpload` sets.
      await setMediumOwner(ctx.kv, medium.id, session.accountId);
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
    description:
      "Step 1 of direct image upload: obtain a pre-signed URL and headers " +
      "for a PUT request. After uploading, call `finishMediumUpload` with " +
      "the returned `uploadId`. Requires authentication.",
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
    description: "Step 2 of direct image upload: confirm that the PUT to the " +
      "pre-signed URL from `startMediumUpload` has completed, returning " +
      "the resulting `Medium`. Requires authentication.",
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
    description:
      "Associate an uploaded `Medium` with an article draft so it can be " +
      "referenced in the draft's Markdown as `hp-medium:{key}`. Must be " +
      "called before publishing if the draft's content uses `hp-medium:` " +
      "references. Requires authentication.",
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

interface AttachedArticleSourceMedium {
  key: string;
  medium: schema.Medium;
}

builder.relayMutationField(
  "attachArticleSourceMedium",
  {
    description:
      "Associate an uploaded `Medium` with a published article so it can " +
      "be referenced in the article's Markdown as `hp-medium:{key}`. Use " +
      "this when adding new media to an article during editing: pair each " +
      "attach call with an `hp-medium:` reference in the new content " +
      "passed to `updateArticle`. The viewer must own the article. " +
      "Requires authentication.",
    inputFields: (t) => ({
      articleSourceId: t.field({
        type: "UUID",
        required: true,
        description:
          "UUID of the `ArticleSource` to attach the medium to. The viewer " +
          "must be the article's author.",
      }),
      mediumId: t.field({
        type: "UUID",
        required: true,
        description: "UUID of a `Medium` to make available to the article.",
      }),
      key: t.string({
        required: false,
        description:
          "Key used in article markdown as hp-medium:KEY. Defaults to mediumId.",
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      const source = await ctx.db.query.articleSourceTable.findFirst({
        where: { id: args.input.articleSourceId },
        columns: { id: true, accountId: true },
      });
      if (source == null || source.accountId !== session.accountId) {
        throw new InvalidInputError("articleSourceId");
      }
      const medium = await ctx.db.query.mediumTable.findFirst({
        where: { id: args.input.mediumId },
      });
      if (medium == null) throw new InvalidInputError("mediumId");
      // During the upload window the medium is private to its uploader.
      // Block attaching a freshly-uploaded medium that belongs to someone
      // else, matching the ownership check used by `Medium.generatedAltText`.
      // After the window expires the medium is either publicly referenced
      // or pending orphan cleanup, so any authenticated owner of the
      // target article may attach it.
      const isOwner = await isMediumOwner(
        ctx.kv,
        medium.id,
        session.accountId,
      );
      if (!isOwner) {
        const windowActive = await isMediumUploadWindowActive(
          ctx.kv,
          medium.id,
        );
        if (windowActive) throw new NotAuthorizedError();
      }
      const key = args.input.key?.trim() || medium.id;
      if (!key.match(/^[A-Za-z0-9._:/-]+$/)) {
        throw new InvalidInputError("key");
      }
      // Don't silently overwrite an existing row. A published article's
      // rendered HTML resolves `hp-medium:KEY` against this table at
      // request time, so changing the `mediumId` for an in-use key would
      // change the live article without going through `updateArticle`
      // (no timestamp bump, no ActivityPub `Update`). Treat re-attaching
      // the same medium as idempotent; reject conflicting medium IDs.
      const inserted = await ctx.db.insert(articleSourceMediumTable).values({
        articleSourceId: source.id,
        key,
        mediumId: medium.id,
      }).onConflictDoNothing().returning();
      if (inserted.length === 0) {
        const existing = await ctx.db.query.articleSourceMediumTable
          .findFirst({
            where: { articleSourceId: source.id, key },
          });
        if (existing == null || existing.mediumId !== medium.id) {
          throw new InvalidInputError("key");
        }
      }
      return { key, medium } satisfies AttachedArticleSourceMedium;
    },
  },
  {
    outputFields: (t) => ({
      key: t.string({
        description:
          "The key the medium was attached under. Reference it in the " +
          "article's Markdown as `hp-medium:KEY`. Equals the requested " +
          "`key` input when provided, otherwise the medium's UUID.",
        resolve: (result) => result.key,
      }),
      medium: t.field({
        type: Medium,
        description: "The `Medium` that was attached to the article source.",
        resolve: (result) => result.medium,
      }),
    }),
  },
);
