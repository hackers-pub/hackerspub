import { revalidate } from "@solidjs/router";

export const NOTIFICATIONS_PAGE_QUERY_CACHE_KEY = "loadNotificationsPageQuery";

export function invalidateNotificationsPageQueryCache(): void {
  void revalidate(NOTIFICATIONS_PAGE_QUERY_CACHE_KEY);
}
