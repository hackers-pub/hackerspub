import { revalidate } from "@solidjs/router";
import type { LoadQueryOptions } from "solid-relay";

export const TIMELINE_PAGE_QUERY_CACHE_KEYS = {
  news: "loadNewsPageQuery",
  feed: "loadFeedTimelineQuery",
  feedWithoutShares: "loadWithoutSharesFeedTimelineQuery",
  feedArticles: "loadArticlesFeedTimelineQuery",
  local: "loadLocalTimelineQuery",
  fediverse: "loadFediverseTimelineQuery",
} as const;

export type TimelinePageQueryCacheKey =
  (typeof TIMELINE_PAGE_QUERY_CACHE_KEYS)[keyof typeof TIMELINE_PAGE_QUERY_CACHE_KEYS];

const networkOnlyTimelinePageQueryKeys = new Set<TimelinePageQueryCacheKey>();
const networkOnlyTimelinePageQueryTimeouts = new Map<
  TimelinePageQueryCacheKey,
  ReturnType<typeof setTimeout>
>();

export function invalidateTimelinePageQueryCache(
  key: TimelinePageQueryCacheKey,
): void {
  networkOnlyTimelinePageQueryKeys.add(key);
  const timeout = networkOnlyTimelinePageQueryTimeouts.get(key);
  if (timeout != null) clearTimeout(timeout);
  networkOnlyTimelinePageQueryTimeouts.set(
    key,
    setTimeout(() => {
      networkOnlyTimelinePageQueryKeys.delete(key);
      networkOnlyTimelinePageQueryTimeouts.delete(key);
    }, 10_000),
  );
  void revalidate(key);
}

export function getTimelinePageQueryLoadOptions(
  key: TimelinePageQueryCacheKey,
): LoadQueryOptions | undefined {
  if (!networkOnlyTimelinePageQueryKeys.has(key)) return undefined;
  return { fetchPolicy: "network-only" };
}
