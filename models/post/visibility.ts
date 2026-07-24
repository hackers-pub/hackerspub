import { PUBLIC_COLLECTION } from "@fedify/vocab";
import type { Database, RelationsFilter } from "../db.ts";
import type {
  Actor,
  Blocking,
  Following,
  Mention,
  Post,
  PostVisibility,
  QuotePolicy,
} from "../schema.ts";
import type { Uuid } from "../uuid.ts";
import type { PostObject } from "./core.ts";

export type QuotePolicyPost = Post & {
  actor: Actor & {
    followers: Following[];
    blockees: Blocking[];
    blockers: Blocking[];
  };
  mentions: Mention[];
};

const maxQuoteShareChainDepth = 16;

export function normalizeQuotePolicyForVisibility(
  visibility: PostVisibility,
  quotePolicy: QuotePolicy | null | undefined,
): QuotePolicy {
  if (visibility !== "public" && visibility !== "unlisted") return "self";
  return quotePolicy ?? "everyone";
}

function quotePolicyFromApprovalUrls(
  post: PostObject,
  approvalUrls: string[],
  authorFollowersUrl: string | null,
): QuotePolicy | undefined {
  if (approvalUrls.includes(PUBLIC_COLLECTION.href)) return "everyone";
  if (authorFollowersUrl != null && approvalUrls.includes(authorFollowersUrl)) {
    return "followers";
  }
  if (
    post.attributionId != null &&
    approvalUrls.includes(post.attributionId.href)
  ) {
    return "self";
  }
  return undefined;
}

export function quotePoliciesFromInteractionPolicy(
  post: PostObject,
  visibility: PostVisibility,
  authorFollowersUrl: string | null,
): {
  quotePolicy: QuotePolicy;
  quoteRequestPolicy: QuotePolicy | null;
} {
  if (visibility !== "public" && visibility !== "unlisted") {
    return { quotePolicy: "self", quoteRequestPolicy: null };
  }
  const policy = post.interactionPolicy?.canQuote;
  if (policy == null) {
    return {
      quotePolicy: normalizeQuotePolicyForVisibility(visibility, undefined),
      quoteRequestPolicy: null,
    };
  }
  const quotePolicy =
    quotePolicyFromApprovalUrls(
      post,
      policy.automaticApprovals.map((url) => url.href),
      authorFollowersUrl,
    ) ?? "self";
  const quoteRequestPolicy =
    quotePolicyFromApprovalUrls(
      post,
      policy.manualApprovals.map((url) => url.href),
      authorFollowersUrl,
    ) ?? null;
  return { quotePolicy, quoteRequestPolicy };
}

function canActorQuoteByPolicy(
  post: Post & { actor: Actor & { followers: Following[] } },
  actor: Actor,
  policy: QuotePolicy,
): boolean {
  if (post.actorId === actor.id) return true;
  if (policy === "everyone") return true;
  if (policy === "followers") {
    return post.actor.followers.some(
      (follower) =>
        follower.followerId === actor.id && follower.accepted != null,
    );
  }
  return false;
}

export function canActorQuotePost(
  post: Post & {
    actor: Actor & {
      followers: Following[];
      blockees: Blocking[];
      blockers: Blocking[];
    };
    mentions: Mention[];
  },
  actor: Actor,
): boolean {
  if (post.sharedPostId != null) return false;
  if (post.visibility === "direct" || post.visibility === "none") return false;
  if (!isPostVisibleTo(post, actor)) return false;
  return canActorQuoteByPolicy(post, actor, post.quotePolicy);
}

export function canActorRequestQuotePost(
  post: Post & {
    actor: Actor & {
      followers: Following[];
      blockees: Blocking[];
      blockers: Blocking[];
    };
    mentions: Mention[];
  },
  actor: Actor,
): boolean {
  if (canActorQuotePost(post, actor)) return true;
  if (post.sharedPostId != null) return false;
  if (post.visibility === "direct" || post.visibility === "none") return false;
  if (!isPostVisibleTo(post, actor)) return false;
  if (post.quoteRequestPolicy == null) return false;
  return canActorQuoteByPolicy(post, actor, post.quoteRequestPolicy);
}

export async function getAllowedQuoteTargetForActor(
  db: Database,
  actor: Actor,
  post: Post,
): Promise<QuotePolicyPost | undefined> {
  const targetPostId = await getOriginalPostId(db, post);
  if (targetPostId == null) return undefined;
  const quotedPost: QuotePolicyPost | undefined =
    await db.query.postTable.findFirst({
      with: {
        actor: {
          with: {
            followers: { where: { followerId: actor.id } },
            blockees: { where: { blockeeId: actor.id } },
            blockers: { where: { blockerId: actor.id } },
          },
        },
        mentions: { where: { actorId: actor.id } },
      },
      where: { id: targetPostId },
    });
  if (quotedPost == null) return undefined;
  // A censored post cannot be quoted (by anyone, including its author):
  // quoting re-amplifies moderation-hidden content.  The submitted row
  // is checked too, so a censored share wrapper cannot be used as a
  // quote handle either.
  if (post.censored != null || quotedPost.censored != null) {
    return undefined;
  }
  const allowed = canActorRequestQuotePost(quotedPost, actor);
  return allowed ? quotedPost : undefined;
}

export async function getOriginalPostId(
  db: Database,
  post: Pick<Post, "id" | "sharedPostId">,
): Promise<Uuid | undefined> {
  const visited = new Set<Uuid>([post.id]);
  let target = post;
  let depth = 0;
  while (target.sharedPostId != null) {
    if (depth >= maxQuoteShareChainDepth) return undefined;
    depth++;
    if (visited.has(target.sharedPostId)) return undefined;
    visited.add(target.sharedPostId);
    const next = await db.query.postTable.findFirst({
      columns: { id: true, sharedPostId: true },
      where: { id: target.sharedPostId },
    });
    if (next == null) return undefined;
    target = next;
  }
  return target.id;
}
export function isPostVisibleTo(
  post: Post & {
    actor: Actor & {
      followers: Following[];
      blockees: Blocking[];
      blockers: Blocking[];
    };
    mentions: Mention[];
  },
  actor?: Actor,
): boolean;
export function isPostVisibleTo(
  post: Post & {
    actor: Actor & {
      followers: (Following & { follower: Actor })[];
      blockees: (Blocking & { blockee: Actor })[];
      blockers: (Blocking & { blocker: Actor })[];
    };
    mentions: (Mention & { actor: Actor })[];
  },
  actor?: { iri: string },
): boolean;
export function isPostVisibleTo(
  post: Post & {
    actor: Actor & {
      followers: (Following & { follower?: Actor })[];
      blockees: (Blocking & { blockee?: Actor })[];
      blockers: (Blocking & { blocker?: Actor })[];
    };
    mentions: (Mention & { actor?: Actor })[];
    sharedPost?: (Post & { actor: Actor }) | null;
  },
  actor?: Actor | { iri: string },
): boolean {
  // A share wrapper's visibility depends on the boosted post (its author's
  // block and sanction state, which the booster's actor does not carry).
  // When the boosted post was not loaded, that cannot be evaluated, so fail
  // closed rather than let a wrapper of a hidden post pass on the booster
  // alone (e.g. an interaction resolver that has only a wrapper id).
  if (post.sharedPostId != null && post.sharedPost == null) return false;
  // A share wrapper denormalizes the boosted post's content, so a boost
  // of a sanction-hidden actor's post is hidden too (when the relation
  // is loaded).  Checked before the wrapper-author fast path: only the
  // boosted post's author keeps access, not the booster.
  if (post.sharedPost?.actor != null) {
    const sharedAuthor = post.sharedPost.actor;
    const viewerIsSharedAuthor =
      actor != null &&
      ("id" in actor
        ? sharedAuthor.id === actor.id
        : sharedAuthor.iri === actor.iri);
    if (!viewerIsSharedAuthor && isActorSanctionHidden(sharedAuthor)) {
      return false;
    }
  }
  if (actor != null) {
    if (
      ("id" in actor && post.actor.id === actor.id) ||
      ("iri" in actor && post.actor.iri === actor.iri)
    ) {
      return true;
    }
  }
  if (isActorSanctionHidden(post.actor)) return false;
  if (actor != null) {
    const blocked =
      "id" in actor
        ? post.actor.blockees.some((b) => b.blockeeId === actor.id) ||
          post.actor.blockers.some((b) => b.blockerId === actor.id)
        : post.actor.blockees.some((b) => b.blockee?.iri === actor.iri) ||
          post.actor.blockers.some((b) => b.blocker?.iri === actor.iri);
    if (blocked) return false;
  }
  if (post.visibility === "public" || post.visibility === "unlisted") {
    return true;
  }
  if (actor == null) return false;
  if (post.visibility === "followers") {
    if ("id" in actor) {
      return (
        post.actor.followers.some(
          (follower) =>
            follower.followerId === actor.id && follower.accepted != null,
        ) || post.mentions.some((mention) => mention.actorId === actor.id)
      );
    } else {
      return (
        post.actor.followers.some(
          (follower) =>
            follower.follower?.iri === actor.iri && follower.accepted != null,
        ) || post.mentions.some((mention) => mention.actor?.iri === actor.iri)
      );
    }
  }
  if (post.visibility === "direct") {
    if ("id" in actor) {
      return post.mentions.some((mention) => mention.actorId === actor.id);
    } else {
      return post.mentions.some((mention) => mention.actor?.iri === actor.iri);
    }
  }
  return false;
}

export interface PostInteractionPolicy {
  readonly canReply: boolean;
  readonly canQuote: boolean;
  readonly canShare: boolean;
}

const DENY_ALL: PostInteractionPolicy = {
  canReply: false,
  canQuote: false,
  canShare: false,
};

export async function getPostInteractionPolicies(
  db: Database,
  postIds: readonly Uuid[],
  viewer: Actor | null,
): Promise<Map<Uuid, PostInteractionPolicy>> {
  const result = new Map<Uuid, PostInteractionPolicy>();
  for (const id of postIds) result.set(id, DENY_ALL);
  if (postIds.length < 1 || viewer == null) return result;

  // Filter each viewer-relevant relation down to the viewer's row only.
  // `isPostVisibleTo` just checks `.some(... === viewer.id ...)`, so loading
  // the full follower/blockee/blocker/mention sets for popular actors is
  // wasteful — at most one row per relation actually matters.
  const posts = await db.query.postTable.findMany({
    with: {
      actor: {
        with: {
          followers: { where: { followerId: viewer.id } },
          blockees: { where: { blockeeId: viewer.id } },
          blockers: { where: { blockerId: viewer.id } },
        },
      },
      mentions: { where: { actorId: viewer.id } },
      sharedPost: {
        with: {
          actor: {
            with: {
              followers: { where: { followerId: viewer.id } },
              blockees: { where: { blockeeId: viewer.id } },
              blockers: { where: { blockerId: viewer.id } },
            },
          },
          mentions: { where: { actorId: viewer.id } },
        },
      },
    },
    where: {
      id: { in: postIds as Uuid[] },
    },
  });

  for (const post of posts) {
    if (!isPostVisibleTo(post, viewer)) continue;
    const effective = post.sharedPost ?? post;
    // A censored post (or a wrapper of one) cannot be boosted or quoted by
    // anyone, including its author or a moderator: both actions re-amplify
    // moderation-hidden content, and the share/quote mutations reject them
    // outright.  Deny the policy too so the UI never offers an affordance
    // that is guaranteed to fail.
    const censored = post.censored != null || effective.censored != null;
    const canAmplify =
      !censored &&
      effective.sharedPostId == null &&
      isPostVisibleTo(effective, viewer) &&
      (effective.visibility === "public" ||
        effective.visibility === "unlisted" ||
        (effective.visibility === "followers" &&
          effective.actorId === viewer.id));
    const canQuote =
      !censored &&
      effective.sharedPostId == null &&
      isPostVisibleTo(effective, viewer) &&
      canActorRequestQuotePost(effective, viewer);
    result.set(post.id, {
      canReply: true,
      canQuote,
      canShare: canAmplify,
    });
  }
  return result;
}

/**
 * Builds a post filter that excludes posts whose author (or whose shared
 * original's author) is muted by the given muter.  The `sharedPost` clause
 * matters for the public timeline, where shares are wrapper posts: it hides a
 * muted author's content even when an unmuted account boosts it.  (In the
 * personal timeline `post_id` always points at the underlying post, so the
 * `sharedPost` clause is a harmless no-op there; muted *sharers* are handled
 * separately via `timeline_item.last_sharer_id`.)
 *
 * Unlike {@link getActorContentExclusionFilter} (used for blocking), this is
 * intentionally NOT folded into {@link getPostVisibilityFilter}: muting must
 * only hide content from feeds, not from the muted actor's own profile or from
 * thread views.  Apply it explicitly in feed queries.
 */
export function getMutedActorExclusionFilter(
  muterActorId: Uuid,
): RelationsFilter<"postTable"> {
  return {
    actor: { NOT: { muters: { muterId: muterActorId } } },
    NOT: { sharedPost: { actor: { muters: { muterId: muterActorId } } } },
  } satisfies RelationsFilter<"postTable">;
}

/**
 * Builds a post filter that excludes censored posts (and boosts of censored
 * posts) from feed-like surfaces: timelines, search, news, and profile post
 * lists.  Like {@link getMutedActorExclusionFilter}, this is intentionally
 * NOT folded into {@link getPostVisibilityFilter}: a censored post's
 * permalink must remain reachable so it can show a censorship notice
 * instead of disappearing with a 404.  Apply it explicitly in list queries.
 *
 * When `viewerActorId` is given, the viewer's own censored posts stay
 * visible to them ("author can still view their own content").
 */
export function getCensoredPostExclusionFilter(
  viewerActorId?: Uuid | null,
): RelationsFilter<"postTable"> {
  return {
    ...(viewerActorId == null
      ? { censored: { isNull: true } }
      : {
          OR: [{ censored: { isNull: true } }, { actorId: viewerActorId }],
        }),
    NOT: { sharedPost: { censored: { isNotNull: true } } },
  } satisfies RelationsFilter<"postTable">;
}

/**
 * Matches actors whose content is currently hidden by a moderation
 * sanction: banned local actors (permanent suspension) and remote actors
 * under an active federation block (temporary or permanent).  A
 * *temporarily* suspended local actor's content stays visible; only their
 * ability to write is restricted.
 *
 * Sanction activeness is always evaluated by time comparison against the
 * given instant, so expired suspensions need no cleanup writes.
 *
 * This is a *positive* matcher; it is only safe to negate at the relation
 * level (`NOT: { sharedPost: { actor: ... } }` compiles to `NOT EXISTS`).
 * Negating it directly on an actor row would trip SQL's three-valued
 * logic: for unsanctioned actors `suspended` is `NULL`, the comparison
 * evaluates to `NULL`, and `NOT NULL` is still `NULL`, filtering the row
 * out.  Use {@link getSanctionVisibleActorFilter} for the inclusion form.
 */
export function getSanctionHiddenActorFilter(
  now: Date = new Date(),
): RelationsFilter<"actorTable"> {
  return {
    suspended: { lte: now },
    OR: [
      // Remote actor under an active federation block:
      { accountId: { isNull: true }, suspendedUntil: { isNull: true } },
      { accountId: { isNull: true }, suspendedUntil: { gt: now } },
      // Banned local actor:
      { accountId: { isNotNull: true }, suspendedUntil: { isNull: true } },
    ],
  } satisfies RelationsFilter<"actorTable">;
}

/**
 * The TypeScript-side counterpart of {@link getSanctionHiddenActorFilter}:
 * whether the actor's content is currently hidden by a moderation sanction
 * (banned local actor, or remote actor under an active federation block).
 */
export function isActorSanctionHidden(
  actor: Pick<Actor, "accountId" | "suspended" | "suspendedUntil">,
  now: Date = new Date(),
): boolean {
  if (actor.suspended == null || actor.suspended > now) return false;
  if (actor.suspendedUntil != null && actor.suspendedUntil <= now) {
    return false; // Expired.
  }
  // An active *temporary* suspension of a local actor only restricts
  // writing; a permanent one (ban), or any active sanction on a remote
  // actor (federation block), hides content.
  return actor.accountId == null || actor.suspendedUntil == null;
}

/**
 * The NULL-safe inclusion complement of
 * {@link getSanctionHiddenActorFilter}: matches actors whose content is
 * NOT hidden by a moderation sanction, including the common case where
 * `suspended` is `NULL`.
 */
export function getSanctionVisibleActorFilter(
  now: Date = new Date(),
): RelationsFilter<"actorTable"> {
  return {
    OR: [
      // Not sanctioned at all:
      { suspended: { isNull: true } },
      // Sanction not started yet:
      { suspended: { gt: now } },
      // Sanction already expired:
      { suspendedUntil: { lte: now } },
      // Active temporary suspension of a *local* actor only restricts
      // writing; their content stays visible:
      { accountId: { isNotNull: true }, suspendedUntil: { gt: now } },
    ],
  } satisfies RelationsFilter<"actorTable">;
}

function getActorContentExclusionFilter(
  actorId: Uuid,
): RelationsFilter<"actorTable"> {
  return {
    AND: [
      {
        NOT: {
          OR: [
            { blockees: { blockeeId: actorId } },
            { blockers: { blockerId: actorId } },
          ],
        },
      },
      getSanctionVisibleActorFilter(),
    ],
  } satisfies RelationsFilter<"actorTable">;
}

export function getPostVisibilityFilter(
  actor: Actor | null,
): RelationsFilter<"postTable">;
export function getPostVisibilityFilter(
  actor: Post,
): RelationsFilter<"actorTable">;

export function getPostVisibilityFilter(
  actorOrPost: Actor | Post | null,
): RelationsFilter<"postTable"> | RelationsFilter<"actorTable"> {
  if (actorOrPost == null) {
    return {
      visibility: { in: ["public", "unlisted"] },
      actor: getSanctionVisibleActorFilter(),
      NOT: { sharedPost: { actor: getSanctionHiddenActorFilter() } },
    } satisfies RelationsFilter<"postTable">;
  }
  if ("accountId" in actorOrPost) {
    return {
      actor: getActorContentExclusionFilter(actorOrPost.id),
      NOT: { sharedPost: { actor: getSanctionHiddenActorFilter() } },
      OR: [
        { actorId: actorOrPost.id },
        { visibility: { in: ["public", "unlisted"] } },
        { mentions: { actorId: actorOrPost.id } },
        {
          visibility: "followers",
          actor: {
            followers: {
              followerId: actorOrPost.id,
              accepted: { isNotNull: true },
            },
          },
        },
      ],
    } satisfies RelationsFilter<"postTable">;
  } else {
    if (
      actorOrPost.visibility === "public" ||
      actorOrPost.visibility === "unlisted"
    ) {
      return getActorContentExclusionFilter(actorOrPost.actorId);
    }
    return {
      AND: [
        getActorContentExclusionFilter(actorOrPost.actorId),
        {
          OR: [
            { id: actorOrPost.actorId },
            { mentions: { postId: actorOrPost.id } },
            ...(actorOrPost.visibility === "followers"
              ? [
                  {
                    followees: {
                      followeeId: actorOrPost.actorId,
                      accepted: { isNotNull: true },
                    } satisfies RelationsFilter<"followingTable">,
                  },
                ]
              : []),
          ],
        },
      ],
    } satisfies RelationsFilter<"actorTable">;
  }
}

export function getPublicTimelineVisibilityFilter(
  actor: Actor | null,
): RelationsFilter<"postTable"> {
  if (actor == null) {
    return {
      visibility: "public",
      actor: getSanctionVisibleActorFilter(),
      NOT: { sharedPost: { actor: getSanctionHiddenActorFilter() } },
    } satisfies RelationsFilter<"postTable">;
  }
  return {
    actor: getActorContentExclusionFilter(actor.id),
    NOT: { sharedPost: { actor: getSanctionHiddenActorFilter() } },
    visibility: "public",
  } satisfies RelationsFilter<"postTable">;
}
