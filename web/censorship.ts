import { getAvatarUrl } from "@hackerspub/models/avatar";
import { isActorBanned } from "@hackerspub/models/moderation";
import type {
  Account,
  Actor,
  ArticleContent,
  Post,
} from "@hackerspub/models/schema";
import { escape } from "@std/html/entities";
import type { State } from "./utils.ts";

/** The anonymous placeholder avatar served for hidden profiles. */
const ANONYMOUS_AVATAR_URL = getAvatarUrl({ avatarUrl: null });

/**
 * Whether the legacy web UI must hide an actor's profile content from this
 * viewer: the actor is permanently suspended (banned), and the viewer is
 * neither the actor nor a moderator.  Mirrors the GraphQL layer's
 * `isActorProfileHidden` and the content-less ActivityPub `Person` stub
 * served for banned accounts.  A temporary suspension only restricts
 * writing, so it does NOT hide the profile.
 */
export function isProfileHiddenFor(
  actor: Pick<Actor, "id" | "suspended" | "suspendedUntil">,
  account?:
    | (Pick<Account, "moderator"> & { actor: Pick<Actor, "id"> })
    | undefined,
): boolean {
  return isActorBanned(actor) &&
    account?.actor.id !== actor.id &&
    !(account?.moderator ?? false);
}

/**
 * Returns a copy of the actor with its profile content emptied (display
 * name, bio, profile fields, header) and the avatar replaced with the
 * anonymous placeholder, for rendering a banned actor's profile to
 * viewers who must not see it.  Identity (username, handle) stays.
 */
export function redactHiddenProfileActor<
  T extends Pick<
    Actor,
    "name" | "bioHtml" | "avatarUrl" | "headerUrl" | "fieldHtmls"
  >,
>(actor: T): T {
  return {
    ...actor,
    name: null,
    bioHtml: null,
    avatarUrl: ANONYMOUS_AVATAR_URL,
    headerUrl: null,
    fieldHtmls: {},
  };
}

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
    actor?: Pick<Actor, "accountId" | "handle">;
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
    // A remote post's `url`/`iri` point at the remote origin, where the
    // content lives uncensored; components fall back from `url` to `iri`
    // for display links, so both are replaced with the local permalink
    // path (which renders this notice).  A local post's own links already
    // lead to local pages showing the notice.
    ...(post.actor != null && post.actor.accountId == null
      ? { url: null, iri: `/${post.actor.handle}/${post.id}` }
      : {}),
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
