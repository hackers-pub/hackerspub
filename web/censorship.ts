import type {
  Account,
  Actor,
  ArticleContent,
  Post,
} from "@hackerspub/models/schema";
import { escape } from "@std/html/entities";
import type { State } from "./utils.ts";

/**
 * Whether the legacy web UI must hide a censored post's content from this
 * viewer.  Mirrors the GraphQL layer's redaction rule: the author and
 * moderators still see the content; everyone else gets a notice instead.
 * (List queries already exclude censored posts at the model level; this
 * covers direct permalinks and APIs, which stay reachable on purpose.)
 */
export function isPostCensoredFor(
  post: Pick<Post, "censored" | "actorId">,
  account?: Pick<Account, "moderator"> & { actor: Pick<Actor, "id"> },
): boolean {
  return post.censored != null && !(account?.moderator ?? false) &&
    account?.actor.id !== post.actorId;
}

function censoredNoticeText(t: State["t"]): string {
  return `${t("post.censoredTitle")} ${t("post.censoredDescription")}`;
}

/**
 * Returns a copy of the post with every content-bearing field replaced by
 * a localized censorship notice, for rendering or serializing to viewers
 * who must not see the original content.  Loaded `mentions`, `media`,
 * `link`, `sharedPost`, and `articleSource` relations are emptied too, and
 * the quote reference is cleared so no quoted-post card is rendered;
 * counters and identity fields stay.
 */
export function redactCensoredPost<
  T extends Post & {
    mentions?: unknown[];
    media?: unknown[];
    link?: unknown;
    sharedPost?: unknown;
    articleSource?: unknown;
  },
>(post: T, t: State["t"]): T {
  return {
    ...post,
    name: null,
    summary: null,
    contentHtml: `<p>${escape(censoredNoticeText(t))}</p>`,
    tags: {},
    relayedTags: [],
    emojis: {},
    linkId: null,
    linkUrl: null,
    quotedPostId: null,
    quoteAuthorizationIri: null,
    quoteTargetState: null,
    // A censored share wrapper must not point at the boosted post (the
    // share itself is the censored content); mirrors the GraphQL layer's
    // `Post.url` rule.
    ...(post.sharedPostId == null ? {} : { sharedPostId: null, url: null }),
    ...(post.link === undefined ? {} : { link: null }),
    ...(post.sharedPost === undefined ? {} : { sharedPost: null }),
    ...(post.articleSource === undefined ? {} : { articleSource: null }),
    ...(post.mentions === undefined ? {} : { mentions: [] }),
    ...(post.media === undefined ? {} : { media: [] }),
  };
}

/**
 * Returns a copy of an article content version with the title, body, and
 * summary replaced by a localized censorship notice.  `summary` is set
 * (not nulled) so callers do not kick off the LLM summarizer over the
 * notice text.
 */
export function redactCensoredArticleContent(
  content: ArticleContent,
  t: State["t"],
): ArticleContent {
  return {
    ...content,
    title: t("post.censoredTitle"),
    summary: t("post.censoredDescription"),
    content: censoredNoticeText(t),
    beingTranslated: false,
    // The pre-generated OpenGraph image renders the original title.
    ogImageKey: null,
  };
}
