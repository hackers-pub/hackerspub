// Compatibility facade.  New code should import the narrowest `post/*`
// feature module so dependencies remain explicit.
export {
  getPersistedPost,
  getPostByUsernameAndId,
  isArticleLike,
  isPostObject,
  type PostObject,
} from "./post/core.ts";
export {
  revokeQuote,
  updateQuotesCount,
  updateRepliesCount,
  updateSharesCount,
} from "./post/engagement.ts";
export { deletePost } from "./post/lifecycle.ts";
export {
  deletePersistedPost,
  deleteSharedPost,
  PERSIST_POST_OVERALL_BUDGET_MS,
  persistPost,
  persistSharedPost,
  REMOTE_FETCH_TIMEOUT_MS,
  withDocumentLoaderTimeout,
} from "./post/remote.ts";
export { arePostsSharedBy, sharePost, unsharePost } from "./post/sharing.ts";
export {
  syncPostFromArticleSource,
  syncPostFromNoteSource,
} from "./post/source.ts";
export {
  canActorQuotePost,
  canActorRequestQuotePost,
  getAllowedQuoteTargetForActor,
  getCensoredPostExclusionFilter,
  getMutedActorExclusionFilter,
  getOriginalPostId,
  getPostInteractionPolicies,
  getPostVisibilityFilter,
  getPublicTimelineVisibilityFilter,
  getSanctionHiddenActorFilter,
  getSanctionVisibleActorFilter,
  isActorSanctionHidden,
  isPostVisibleTo,
  normalizeQuotePolicyForVisibility,
  type PostInteractionPolicy,
} from "./post/visibility.ts";
export { persistPostLink, scrapePostLink } from "./link-preview.ts";
