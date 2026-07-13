import * as vocab from "@fedify/vocab";
import { generateAltText } from "@hackerspub/ai/alttext";
import { getLogger } from "@logtape/logtape";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import {
  resolveArrayConnection,
  resolveOffsetConnection,
} from "@pothos/plugin-relay";
import { unreachable } from "@std/assert";
import { assertNever } from "@std/assert/unstable-never";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import {
  arePostsBookmarkedBy,
  getBookmarkCountsForPosts,
} from "@hackerspub/models/bookmark";
import type { Database, Transaction } from "@hackerspub/models/db";
import { renderCustomEmojis } from "@hackerspub/models/emoji";
import {
  addExternalLinkTargets,
  removeQuoteInlineFallback,
  sanitizeExcerptHtml,
  stripHtml,
  transformMentions,
  truncateHtml,
} from "@hackerspub/models/html";
import { assertAccountActorNotSuspended } from "@hackerspub/models/moderation";
import { recordOrganizationPostAuthor } from "@hackerspub/models/organization";
import {
  getCensoredPostExclusionFilter,
  getPostInteractionPolicies,
  getPostVisibilityFilter,
  getSanctionVisibleActorFilter,
  isActorSanctionHidden,
  type PostInteractionPolicy,
} from "@hackerspub/models/post/visibility";
import { actorTable, pinTable, postTable } from "@hackerspub/models/schema";
import type * as schema from "@hackerspub/models/schema";
import DataLoader from "dataloader";
import {
  DESCENDANT_TREE_MAX_DEPTH,
  getAncestorChain,
  getDescendantPage,
} from "@hackerspub/models/thread";
import type { Uuid } from "@hackerspub/models/uuid";
import { isMediumOwner, isMediumUploadWindowActive } from "../medium-upload.ts";
import { createGraphQLError } from "graphql-yoga";
import { Account } from "../account.ts";
import { resolveActingAccountForMutation } from "../acting-account.ts";
import {
  Actor,
  actorProfilePostRelations,
  getActorById,
  isActorProfileHidden,
  loadActorProfilePostPage,
} from "../actor.ts";
import { builder, Node, type UserContext } from "../builder.ts";
import { InvalidInputError, NotAuthorizedError } from "../error.ts";
import { PostVisibility, toPostVisibility } from "../postvisibility.ts";
import {
  QuotePolicy,
  QuoteTargetState,
  toQuotePolicy,
  toQuoteTargetState,
} from "../quotepolicy.ts";
import { Reactable } from "../reactable.ts";
import { NotAuthenticatedError } from "../session.ts";
import {
  type ActingAccountIdArg,
  actingAccountIdArgDescription,
  resolveViewerActorId,
} from "../viewer-actor.ts";

export const articleContentOgImageComplexity = 2_000;
export const logger = getLogger(["hackerspub", "graphql", "post"]);

export class SharedPostDeletionNotAllowedError extends Error {
  public constructor(public readonly inputPath: string) {
    super("Shared posts cannot be deleted. Use unsharePost instead.");
  }
}

export type LlmTranslationNotAllowedReason = "DISABLED" | "SAME_LANGUAGE";

export class LlmTranslationNotAllowedError extends Error {
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

export const PostAttributionMode = builder.enumType("PostAttributionMode", {
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

export const OrganizationPostAuthor = builder.objectRef<
  schema.OrganizationPostAuthor
>(
  "OrganizationPostAuthor",
);

export const LlmTranslationNotAllowedReasonRef = builder.enumType(
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

export async function loadOrganizationPostAuthorAccount(
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

export interface PostActingAccountInput {
  actingAccountId?: { id: string } | null;
  attributionMode?: schema.PostAttributionMode | null;
}

export interface PostManagementActingAccountInput {
  actingAccountId?: { id: string } | null;
}

export interface ResolvedPostActingAccount {
  account: schema.Account & { actor: schema.Actor };
  memberAccountId: Uuid;
  attributionMode: schema.PostAttributionMode | null;
}

export async function resolvePostActingAccount(
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

export async function recordPostActingAccount(
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

export async function assertActingAccountNotSuspended(
  db: Database,
  authenticatedAccountId: Uuid,
  actingAccountId: Uuid,
): Promise<void> {
  await assertAccountActorNotSuspended(db, authenticatedAccountId);
  if (actingAccountId !== authenticatedAccountId) {
    await assertAccountActorNotSuspended(db, actingAccountId);
  }
}

export async function resolvePostManagementActingAccount(
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
export function isCensoredForViewer(
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

export type SanctionActorColumns = Pick<
  schema.Actor,
  "accountId" | "suspended" | "suspendedUntil"
>;

/**
 * The actor columns the redaction helpers need to evaluate the author's
 * sanction state; merged into the field selections that call them.
 */
export const sanctionActorSelection = {
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
export function isRowCensoredForViewer(
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
        return "Article";
      case "Note":
        return "Note";
      case "Question":
        return "Question";
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
    linkPreviewUrl: t.field({
      type: "URL",
      nullable: true,
      description:
        "The exact first external URL shared in this post, including its " +
        "query string and fragment, for link-preview navigation. `null` " +
        "when no preview metadata is attached, and hidden under the same " +
        "moderation rules as `Post.link`. Use `PostLink.url` only as the " +
        "resolved identity used to share preview metadata and news scores.",
      select: {
        columns: { censored: true, actorId: true, linkUrl: true },
        with: { actor: sanctionActorSelection },
      },
      resolve: (post, _, ctx) =>
        isCensoredForViewer(post, ctx) || post.linkUrl == null
          ? null
          : new URL(post.linkUrl),
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
        "Whether the selected viewer account has pinned this post to their " +
        "profile. Always `false` for unauthenticated requests. Pass " +
        "`actingAccountId` for an organization perspective.",
      args: {
        actingAccountId: t.arg.globalID({
          required: false,
          description: actingAccountIdArgDescription,
        }),
      },
      loaderOptions: { cache: false },
      load: loadViewerHasPinned,
      resolve: postViewerActorKey,
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

export const DENY_ALL_POLICY: PostInteractionPolicy = {
  canReply: false,
  canQuote: false,
  canShare: false,
};

export interface ViewerActorPostKey {
  postId: Uuid;
  viewerActorId: Uuid | null;
}

export function viewerActorPostKeyCacheKey(key: ViewerActorPostKey): string {
  return `${key.viewerActorId ?? ""}:${key.postId}`;
}

export async function postViewerActorKey(
  post: { id: Uuid },
  args: ActingAccountIdArg,
  ctx: UserContext,
): Promise<ViewerActorPostKey> {
  return {
    postId: post.id,
    viewerActorId: await resolveViewerActorId(ctx, args),
  };
}

export async function loadViewerHasShared(
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

export async function loadViewerHasPinned(
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

  const pinnedKeys = new Set<string>();
  for (const [viewerActorId, postIds] of postIdsByViewer) {
    const rows = await ctx.db.select({ postId: pinTable.postId })
      .from(pinTable)
      .where(
        and(
          eq(pinTable.actorId, viewerActorId),
          inArray(pinTable.postId, [...postIds]),
        ),
      );
    for (const row of rows) {
      pinnedKeys.add(`${viewerActorId}:${row.postId}`);
    }
  }

  return keys.map((key) =>
    key.viewerActorId != null &&
    pinnedKeys.has(`${key.viewerActorId}:${key.postId}`)
  );
}

export async function loadViewerActionPolicies(
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

export function selectPostRelationWithActor(
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

// Raw rows to scan per round once the `descendants` page is already full and
// the resolver only needs to confirm one more visible reply exists (for
// `hasNextPage`).  Kept small so a probe that finds a survivor early does not
// over-fetch a whole `first`-sized page; a longer run of hidden rows is
// stepped over across the bounded rounds instead.
export const DESCENDANT_PROBE_BATCH = 20;

// A descendants cursor is base64 of the model layer's DFS path: fixed-width
// `<YYYY-MM-DDTHH:MM:SS.ffffff>~<uuid>` elements joined by `/` (the timestamp
// is the node's UTC publish time to microsecond precision).  The uuid parts
// double as the entry's strict ancestor chain below the focused post, which
// the resolver uses to drop entries whose subtree root got filtered out on an
// earlier page.
export const descendantPathElement =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}~[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function encodeDescendantCursor(path: string): string {
  return btoa(path);
}

export function decodeDescendantCursor(cursor: string): string {
  let path: string;
  try {
    path = atob(cursor);
  } catch {
    throw createGraphQLError("Malformed `descendants` cursor.");
  }
  if (
    !path.split("/").every((element) => descendantPathElement.test(element))
  ) {
    throw createGraphQLError("Malformed `descendants` cursor.");
  }
  return path;
}

export function descendantPathAncestorIds(path: string): Uuid[] {
  const elements = path.split("/");
  // Each element is `<sortkey>~<uuid>`; the uuid (36 chars, no `~`) is the id.
  return elements.slice(0, -1).map((element) =>
    element.slice(element.indexOf("~") + 1) as Uuid
  );
}

// Whether the given post is visible to the authenticated viewer: per-post
// visibility plus the author's sanction state.  Censorship is deliberately
// not part of this check; censored posts stay reachable and self-redact
// their content-bearing fields instead.
export function isPostVisibleToViewer(
  ctx: UserContext,
  postId: Uuid,
  viewerActorId: Uuid | null,
): Promise<boolean> {
  ctx.postVisibleLoader ??= new Map();
  let loader = ctx.postVisibleLoader.get(viewerActorId ?? "");
  if (loader == null) {
    loader = new DataLoader<Uuid, boolean>(
      async (ids) => {
        const idList = ids as Uuid[];
        const viewerActor = viewerActorId == null
          ? null
          : await getActorById(ctx, viewerActorId);
        const rows = await ctx.db.query.postTable.findMany({
          columns: { id: true },
          where: {
            AND: [
              { id: { in: idList } },
              { actor: getSanctionVisibleActorFilter(ctx.now ??= new Date()) },
              getPostVisibilityFilter(viewerActor),
            ],
          },
        });
        const visible = new Set(rows.map((row) => row.id));
        return idList.map((id) => visible.has(id));
      },
    );
    ctx.postVisibleLoader.set(viewerActorId ?? "", loader);
  }
  return loader.load(postId);
}

// Whether the given post has at least one direct reply visible to the viewer,
// under the same sanction + censorship + visibility filter as the `replies`
// connection.  Thread views use this instead of the raw
// `engagementStats.replies` counter: a node whose only replies are hidden
// (followers-only to a stranger, censored, or by a sanctioned author) reports
// `false`, so a "continue this thread" affordance cannot reveal that hidden
// replies exist.  Batched (one query per reply page) and keyed by viewer.
export function postHasVisibleReplies(
  ctx: UserContext,
  postId: Uuid,
  viewerActorId: Uuid | null,
): Promise<boolean> {
  ctx.postHasVisibleRepliesLoader ??= new Map();
  let loader = ctx.postHasVisibleRepliesLoader.get(viewerActorId ?? "");
  if (loader == null) {
    loader = new DataLoader<Uuid, boolean>(
      async (ids) => {
        const idList = ids as Uuid[];
        const viewerActor = viewerActorId == null
          ? null
          : await getActorById(ctx, viewerActorId);
        const rows = await ctx.db.query.postTable.findMany({
          columns: { replyTargetId: true },
          where: {
            AND: [
              { replyTargetId: { in: idList } },
              { actor: getSanctionVisibleActorFilter(ctx.now ??= new Date()) },
              getCensoredPostExclusionFilter(viewerActorId),
              getPostVisibilityFilter(viewerActor),
            ],
          },
        });
        const withReplies = new Set(rows.map((row) => row.replyTargetId));
        return idList.map((id) => withReplies.has(id));
      },
    );
    ctx.postHasVisibleRepliesLoader.set(viewerActorId ?? "", loader);
  }
  return loader.load(postId);
}

// Whether the given post has at least one quote visible to the viewer, under
// the same sanction + censorship + visibility filter as the `quotes`
// connection.  The news-discussion view uses this instead of the raw
// `engagementStats.quotes` counter so a "show quotes" affordance (which then
// loads an empty list) cannot reveal that hidden quotes exist.  Batched (one
// query per page) and keyed by viewer, mirroring `postHasVisibleReplies`.
export function postHasVisibleQuotes(
  ctx: UserContext,
  postId: Uuid,
  viewerActorId: Uuid | null,
): Promise<boolean> {
  ctx.postHasVisibleQuotesLoader ??= new Map();
  let loader = ctx.postHasVisibleQuotesLoader.get(viewerActorId ?? "");
  if (loader == null) {
    loader = new DataLoader<Uuid, boolean>(
      async (ids) => {
        const idList = ids as Uuid[];
        const viewerActor = viewerActorId == null
          ? null
          : await getActorById(ctx, viewerActorId);
        const rows = await ctx.db.query.postTable.findMany({
          columns: { quotedPostId: true },
          where: {
            AND: [
              { quotedPostId: { in: idList } },
              { actor: getSanctionVisibleActorFilter(ctx.now ??= new Date()) },
              getCensoredPostExclusionFilter(viewerActorId),
              getPostVisibilityFilter(viewerActor),
            ],
          },
        });
        const withQuotes = new Set(rows.map((row) => row.quotedPostId));
        return idList.map((id) => withQuotes.has(id));
      },
    );
    ctx.postHasVisibleQuotesLoader.set(viewerActorId ?? "", loader);
  }
  return loader.load(postId);
}

// Backs the `Post.replies` / `Post.quotes` / `Post.shares` connections:
// posts related to `targetId` through `column` (`replyTargetId`,
// `quotedPostId`, or `sharedPostId`), newest first, filtered to those
// visible to the selected viewer account.  Resolves the acting account from
// `actingAccountId` (like `ancestors`/`descendants` and `Actor.posts`), so an
// organization perspective sees followers-only interactions the org can see
// but the viewer's personal actor cannot.  Censored and sanction-hidden are
// excluded here (these are lists, not the self-redacting permalink).
export async function visibleRelatedPostsPage(
  ctx: UserContext,
  args: ActingAccountIdArg,
  column: "replyTargetId" | "quotedPostId" | "sharedPostId",
  targetId: Uuid,
  offset: number,
  limit: number,
) {
  const viewerActorId = await resolveViewerActorId(ctx, args);
  const viewerActor = viewerActorId == null
    ? null
    : await getActorById(ctx, viewerActorId);
  const page = await ctx.db.query.postTable.findMany({
    columns: { id: true },
    where: {
      AND: [
        { [column]: targetId },
        { actor: getSanctionVisibleActorFilter(ctx.now ??= new Date()) },
        getCensoredPostExclusionFilter(viewerActorId),
        getPostVisibilityFilter(viewerActor),
      ],
    },
    // `id` breaks `published` ties so offset pagination is stable (no
    // duplicated or skipped rows across pages when timestamps collide). The
    // callback form guarantees both columns order deterministically.
    orderBy: (post, { desc }) => [desc(post.published), desc(post.id)],
    limit,
    offset,
  });
  return await loadActorProfilePostPage(ctx, page, viewerActorId);
}

// Exact count of everything `visibleRelatedPostsPage` would return across all
// pages, for a connection `totalCount` that is not capped by the page size.
// Direct replies/quotes/shares of one post are bounded, so counting ids is
// acceptable; the relational visibility filter cannot be expressed as a plain
// SQL `$count` predicate.  `resolveViewerActorId`/`getActorById` are
// per-request cached, so re-resolving them here is free.
export async function countVisibleRelatedPosts(
  ctx: UserContext,
  args: ActingAccountIdArg,
  column: "replyTargetId" | "quotedPostId" | "sharedPostId",
  targetId: Uuid,
): Promise<number> {
  const viewerActorId = await resolveViewerActorId(ctx, args);
  const viewerActor = viewerActorId == null
    ? null
    : await getActorById(ctx, viewerActorId);
  const rows = await ctx.db.query.postTable.findMany({
    columns: { id: true },
    where: {
      AND: [
        { [column]: targetId },
        { actor: getSanctionVisibleActorFilter(ctx.now ??= new Date()) },
        getCensoredPostExclusionFilter(viewerActorId),
        getPostVisibilityFilter(viewerActor),
      ],
    },
  });
  return rows.length;
}

// The id-only companion of loadVisibleThreadPosts, for checking path
// ancestors that never become connection nodes themselves: same filters,
// no relation hydration.
export async function loadVisibleThreadPostIds(
  ctx: UserContext,
  ids: readonly Uuid[],
  viewerActorId: Uuid | null,
): Promise<Set<Uuid>> {
  if (ids.length < 1) return new Set();
  const viewerActor = viewerActorId == null
    ? null
    : await getActorById(ctx, viewerActorId);
  const rows = await ctx.db.query.postTable.findMany({
    columns: { id: true },
    where: {
      AND: [
        { id: { in: [...ids] } },
        { actor: getSanctionVisibleActorFilter(ctx.now ??= new Date()) },
        getCensoredPostExclusionFilter(viewerActorId),
        getPostVisibilityFilter(viewerActor),
      ],
    },
  });
  return new Set(rows.map((row) => row.id));
}

// Loads the given posts with the canonical thread filters (sanction,
// censorship, visibility) applied, keyed by id; absent ids are not visible
// to the viewer.  The eager relation set matches what profile/timeline post
// loading uses, since these rows bypass Pothos's nested selection machinery.
export async function loadVisibleThreadPosts(
  ctx: UserContext,
  ids: readonly Uuid[],
  viewerActorId: Uuid | null,
) {
  const viewerActor = viewerActorId == null
    ? null
    : await getActorById(ctx, viewerActorId);
  const rows = ids.length < 1 ? [] : await ctx.db.query.postTable.findMany({
    where: {
      AND: [
        { id: { in: [...ids] } },
        { actor: getSanctionVisibleActorFilter(ctx.now ??= new Date()) },
        getCensoredPostExclusionFilter(viewerActorId),
        getPostVisibilityFilter(viewerActor),
      ],
    },
    with: actorProfilePostRelations(viewerActorId),
  });
  return new Map(rows.map((row) => [row.id, row]));
}

export type ThreadPostRow = Awaited<
  ReturnType<typeof loadVisibleThreadPosts>
> extends Map<Uuid, infer R> ? R : never;

builder.drizzleInterfaceFields(Post, (t) => ({
  sharedPost: t.field({
    type: Post,
    nullable: true,
    description:
      "The post being boosted. Non-null only for boost wrapper rows. " +
      "When this is non-null, `content` is empty and `url` mirrors the " +
      "shared post's URL.  `null` when the boost wrapper itself is " +
      "censored, or its author is hidden by a moderation sanction, and " +
      "the viewer is neither the author nor a moderator (what was boosted " +
      "is the censored content), and also when the boosted post is not " +
      "visible to the viewer (e.g., a followers-only post the viewer does " +
      "not follow), so a boost cannot leak its private target.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
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
    resolve: async (post, args, ctx) => {
      if (isRowCensoredForViewer(post, ctx)) return null;
      const sharedPost = hidePostRelationWithoutActor(post.sharedPost);
      if (sharedPost == null) return null;
      const viewerActorId = await resolveViewerActorId(ctx, args);
      return await isPostVisibleToViewer(ctx, sharedPost.id, viewerActorId)
        ? sharedPost
        : null;
    },
  }),
  replyTarget: t.field({
    type: Post,
    nullable: true,
    description:
      "The post this post is a reply to. `null` for top-level posts, and " +
      "also when the parent is not visible to the authenticated viewer " +
      "(e.g., a followers-only post by an actor the viewer does not " +
      "follow, or a post whose author is hidden by a moderation " +
      "sanction), so a public reply cannot leak its private parent. A " +
      "censored parent is still returned and self-redacts its " +
      "content-bearing fields. Pass `actingAccountId` for an " +
      "organization perspective, matching the perspective of the " +
      "surrounding query.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    select: (_, __, nestedSelection) => ({
      with: {
        replyTarget: selectPostRelationWithActor(nestedSelection),
      },
    }),
    resolve: async (post, args, ctx) => {
      const replyTarget = hidePostRelationWithoutActor(post.replyTarget);
      if (replyTarget == null) return null;
      const viewerActorId = await resolveViewerActorId(ctx, args);
      return await isPostVisibleToViewer(ctx, replyTarget.id, viewerActorId)
        ? replyTarget
        : null;
    },
  }),
  quotedPost: t.field({
    type: Post,
    nullable: true,
    description:
      "The post being quoted inline. `null` for posts that are not " +
      "quotes, when the quoting post is censored or its author " +
      "is hidden by a moderation sanction and the viewer " +
      "is neither its author nor a moderator (the quoted target is part " +
      "of the censored content), and also when the quoted post is not " +
      "visible to the viewer (e.g., a followers-only post the viewer does " +
      "not follow), so a public quote cannot leak its private target.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    select: (_, __, nestedSelection) => ({
      columns: { censored: true, actorId: true },
      with: {
        actor: sanctionActorSelection,
        quotedPost: selectPostRelationWithActor(nestedSelection),
      },
    }),
    resolve: async (post, args, ctx) => {
      if (isCensoredForViewer(post, ctx)) return null;
      const quotedPost = hidePostRelationWithoutActor(post.quotedPost);
      if (quotedPost == null) return null;
      const viewerActorId = await resolveViewerActorId(ctx, args);
      return await isPostVisibleToViewer(ctx, quotedPost.id, viewerActorId)
        ? quotedPost
        : null;
    },
  }),
  replies: t.connection({
    type: Post,
    description:
      "Posts that are direct replies to this post, newest first. Censored " +
      "replies, replies by actors whose content is hidden by a moderation " +
      "sanction, and replies not visible to the selected viewer account " +
      "(e.g., followers-only replies by actors the viewer does not " +
      "follow) are excluded. Pass `actingAccountId` for an organization " +
      "perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    resolve: async (post, args, ctx) => {
      const { edges, pageInfo } = await resolveOffsetConnection(
        { args },
        ({ offset, limit }) =>
          visibleRelatedPostsPage(
            ctx,
            args,
            "replyTargetId",
            post.id,
            offset,
            limit,
          ),
      );
      return {
        edges: [...edges],
        pageInfo: {
          hasNextPage: pageInfo.hasNextPage,
          hasPreviousPage: pageInfo.hasPreviousPage,
          startCursor: pageInfo.startCursor,
          endCursor: pageInfo.endCursor,
        },
        // Carried for the lazy `totalCount` field below.
        countTargetId: post.id,
        countArgs: args,
      };
    },
  }, {
    fields: (t) => ({
      totalCount: t.int({
        description:
          "Total number of direct replies visible to the selected viewer " +
          "account, independent of the current page size. Unlike counting " +
          "the fetched edges, this is not capped by `first`, and excludes " +
          "the same censored, sanction-hidden, and not-visible replies as " +
          "the edges.",
        resolve: (connection, _args, ctx) =>
          countVisibleRelatedPosts(
            ctx,
            connection.countArgs,
            "replyTargetId",
            connection.countTargetId,
          ),
      }),
    }),
  }),
  hasVisibleReplies: t.boolean({
    description:
      "Whether this post has at least one direct reply the selected viewer " +
      "can see, under the same filter as the `replies` connection (author " +
      "sanction state, censorship, and per-post visibility). Prefer this " +
      "over `engagementStats.replies > 0` when deciding whether to show a " +
      '"continue this thread" affordance in a thread view: the raw counter ' +
      "includes replies hidden from the viewer (followers-only, direct, " +
      "censored, or by a sanctioned author), so branching on it would " +
      "reveal that hidden replies exist. Pass `actingAccountId` for an " +
      "organization perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    resolve: async (post, args, ctx) => {
      const viewerActorId = await resolveViewerActorId(ctx, args);
      return await postHasVisibleReplies(ctx, post.id, viewerActorId);
    },
  }),
  hasVisibleQuotes: t.boolean({
    description:
      "Whether this post has at least one quote the selected viewer can see, " +
      "under the same filter as the `quotes` connection (author sanction " +
      "state, censorship, and per-post visibility). Prefer this over " +
      "`engagementStats.quotes > 0` when deciding whether to show a " +
      '"show quotes" affordance: the raw counter includes quotes hidden from ' +
      "the viewer (followers-only, direct, censored, or by a sanctioned " +
      "author), so branching on it would surface an affordance that then " +
      "loads an empty list, revealing that hidden quotes exist. Pass " +
      "`actingAccountId` for an organization perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    resolve: async (post, args, ctx) => {
      const viewerActorId = await resolveViewerActorId(ctx, args);
      return await postHasVisibleQuotes(ctx, post.id, viewerActorId);
    },
  }),
  ancestors: t.connection({
    type: Post,
    description:
      "The chain of posts this post replies to, from the nearest parent " +
      "toward the thread root: the first node is the same post as " +
      "`replyTarget`, the last is the oldest reachable ancestor. " +
      "Ancestors that are censored, whose author is hidden by a " +
      "moderation sanction, or that are not visible to the viewer are " +
      "omitted from the chain. To detect such gaps, compare a node's " +
      "`replyTarget` with the next node: a mismatching id (censored " +
      "parent) or a `null` `replyTarget` on a node that is not the last " +
      "one (invisible parent) marks a gap, and a last node with a " +
      "non-`null` `replyTarget` means the chain continues past what was " +
      "returned. The walk is bounded to 200 hops server-side. Pass " +
      "`actingAccountId` for an organization perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    resolve: async (post, args, ctx) => {
      const viewerActorId = await resolveViewerActorId(ctx, args);
      const chain = await getAncestorChain(ctx.db, post.id);
      const visible = await loadVisibleThreadPosts(
        ctx,
        chain.map((entry) => entry.id),
        viewerActorId,
      );
      const nodes = chain.flatMap((entry) => {
        const row = visible.get(entry.id);
        return row == null ? [] : [row];
      });
      return resolveArrayConnection({ args }, nodes);
    },
  }),
  descendants: t.connection({
    type: Post,
    description:
      "Every reply below this post (replies, replies to replies, and so " +
      "on), flattened in depth-first order with siblings ordered by " +
      "`published`. A node's parent (`replyTarget`) always appears " +
      "before the node itself, including across pages, so clients can " +
      "rebuild the tree from `replyTarget` ids alone. Subtrees rooted at " +
      "a censored post, a post by a sanction-hidden actor, or a post " +
      "invisible to the viewer are pruned along with that post. " +
      "Traversal depth is capped at `maxDepth`; fetch a deeper branch " +
      "from the deepest returned post's own `descendants`. Only forward " +
      "pagination (`first`/`after`) is supported. Pass `actingAccountId` " +
      "for an organization perspective.",
    args: {
      maxDepth: t.arg.int({
        description: "Maximum tree depth to traverse below this post (direct " +
          "replies are depth 1). Defaults to 20 and is clamped " +
          "server-side to 40.",
      }),
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    resolve: async (post, args, ctx) => {
      if (args.last != null || args.before != null) {
        throw createGraphQLError(
          "`descendants` only supports forward pagination " +
            "(`first`/`after`).",
        );
      }
      const first = Math.min(Math.max(args.first ?? 60, 1), 200);
      const maxDepth = Math.min(
        Math.max(args.maxDepth ?? 20, 1),
        DESCENDANT_TREE_MAX_DEPTH,
      );
      const viewerActorId = await resolveViewerActorId(ctx, args);
      const edges: { cursor: string; node: ThreadPostRow }[] = [];
      let after = args.after == null
        ? null
        : decodeDescendantCursor(args.after);
      // Whether a reply visible to this viewer exists past the emitted page.
      // Derived from actually finding one more visible survivor, never from the
      // raw `hasMore`: the raw tail can be entirely invisible to this viewer,
      // and reporting `hasNextPage: true` off it would leak that hidden replies
      // exist (the client would then load a phantom, empty next page).
      let sawExtraVisible = false;
      // Bound the work per request so a subtree padded with replies hidden
      // from this viewer cannot make one request scan without limit.  `after`
      // (the raw scan position) advances through hidden runs within a request,
      // but the returned `endCursor` never does: see below.
      const maxRounds = 10;
      for (let round = 0; round < maxRounds; round++) {
        const remaining = first - edges.length;
        const page = await getDescendantPage(ctx.db, post.id, {
          after,
          // While filling, fetch what is left plus one so a single dense page
          // both fills and reveals the next survivor.  Once full, only one more
          // visible survivor is needed, so fetch a small fixed batch (enough to
          // step over a short run of hidden rows) rather than another `first`.
          limit: remaining > 0 ? remaining + 1 : DESCENDANT_PROBE_BATCH,
          maxDepth,
          viewerActorId,
        });
        if (page.entries.length < 1) break;
        const idsToCheck = new Set<Uuid>();
        for (const entry of page.entries) {
          idsToCheck.add(entry.id);
          for (const ancestorId of descendantPathAncestorIds(entry.cursor)) {
            idsToCheck.add(ancestorId);
          }
        }
        const visibleIds = await loadVisibleThreadPostIds(
          ctx,
          [...idsToCheck],
          viewerActorId,
        );
        const survivors = page.entries.filter((entry) =>
          visibleIds.has(entry.id) &&
          descendantPathAncestorIds(entry.cursor).every((id) =>
            visibleIds.has(id)
          )
        );
        const rows = await loadVisibleThreadPosts(
          ctx,
          survivors.map((entry) => entry.id),
          viewerActorId,
        );
        for (const entry of survivors) {
          const row = rows.get(entry.id);
          if (row == null) continue;
          if (edges.length < first) {
            edges.push({
              cursor: encodeDescendantCursor(entry.cursor),
              node: row,
            });
          } else {
            // One visible survivor beyond the emitted page is enough to know a
            // real next page exists; do not emit it, the next request will.
            sawExtraVisible = true;
            break;
          }
        }
        if (sawExtraVisible) break;
        after = page.entries[page.entries.length - 1].cursor;
        if (!page.hasMore) break;
      }
      // `endCursor` is only ever a visible edge we emitted, never a hidden
      // row: a hidden row's cursor is base64 of its path (its id and publish
      // time), so exposing it would disclose that hidden descendants exist and
      // leak their identity.  A page that emits nothing returns a `null`
      // cursor, indistinguishable from a post that has no descendants at all.
      const endCursor = edges.length > 0
        ? edges[edges.length - 1].cursor
        : null;
      // Offer a next page only when the probe actually found one more visible
      // reply, never off unread rows alone.  Once the page is full, a bounded
      // run of replies hidden from this viewer must not surface a "load more"
      // that then yields an empty page: that would disclose that hidden
      // descendants exist.  A visible reply buried under a run of hidden ones
      // longer than the probe budget stays reachable through its own permalink.
      const hasNextPage = sawExtraVisible;
      return {
        edges,
        pageInfo: {
          hasNextPage,
          hasPreviousPage: args.after != null,
          startCursor: edges.length > 0 ? edges[0].cursor : null,
          endCursor,
        },
      };
    },
  }),
  shares: t.connection({
    type: Post,
    description:
      "Boost wrapper posts that reshare this post, newest first. Each edge " +
      "represents a single boost by a specific actor. Censored boosts " +
      "(including boosts of a censored post), boosts by actors whose " +
      "content is hidden by a moderation sanction, and boosts not visible " +
      "to the selected viewer account (e.g., followers-only boosts by " +
      "actors the viewer does not follow) are excluded. Pass " +
      "`actingAccountId` for an organization perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    resolve: async (post, args, ctx) => {
      const { edges, pageInfo } = await resolveOffsetConnection(
        { args },
        ({ offset, limit }) =>
          visibleRelatedPostsPage(
            ctx,
            args,
            "sharedPostId",
            post.id,
            offset,
            limit,
          ),
      );
      return {
        edges: [...edges],
        pageInfo: {
          hasNextPage: pageInfo.hasNextPage,
          hasPreviousPage: pageInfo.hasPreviousPage,
          startCursor: pageInfo.startCursor,
          endCursor: pageInfo.endCursor,
        },
      };
    },
  }),
  quotes: t.connection({
    type: Post,
    description:
      "Posts that quote this post inline, newest first. Censored quotes, " +
      "quotes by actors whose content is hidden by a moderation sanction, " +
      "and quotes not visible to the selected viewer account (e.g., " +
      "followers-only quotes by actors the viewer does not follow) are " +
      "excluded. Pass `actingAccountId` for an organization perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    resolve: async (post, args, ctx) => {
      const { edges, pageInfo } = await resolveOffsetConnection(
        { args },
        ({ offset, limit }) =>
          visibleRelatedPostsPage(
            ctx,
            args,
            "quotedPostId",
            post.id,
            offset,
            limit,
          ),
      );
      return {
        edges: [...edges],
        pageInfo: {
          hasNextPage: pageInfo.hasNextPage,
          hasPreviousPage: pageInfo.hasPreviousPage,
          startCursor: pageInfo.startCursor,
          endCursor: pageInfo.endCursor,
        },
      };
    },
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

export const Hashtag = builder.simpleObject("Hashtag", {
  fields: (t) => ({
    name: t.string(),
    href: t.field({ type: "URL" }),
  }),
});

export const PostEngagementStats = builder.drizzleObject("postTable", {
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

export const mentionConnectionHelpers = drizzleConnectionHelpers(
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

export const PostMediumRef = builder.drizzleNode("postMediumTable", {
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
      const owner = await isMediumOwner(ctx.kv, medium.id, session.accountId);
      if (!owner) {
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

export const MediumUploadHeader = builder.simpleObject("MediumUploadHeader", {
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

export const PostLinkImage = builder.drizzleObject("postLinkTable", {
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
