export type ArticleAnalyticsRange =
  | "SEVEN_DAYS"
  | "THIRTY_DAYS"
  | "NINETY_DAYS"
  | "ALL";

export function parseArticleAnalyticsRange(
  value: string | string[] | undefined,
): ArticleAnalyticsRange {
  const first = Array.isArray(value) ? value[0] : value;
  switch (first) {
    case "7":
      return "SEVEN_DAYS";
    case "90":
      return "NINETY_DAYS";
    case "all":
      return "ALL";
    default:
      return "THIRTY_DAYS";
  }
}

export function articleAnalyticsRangeParam(
  range: ArticleAnalyticsRange,
): string | undefined {
  switch (range) {
    case "SEVEN_DAYS":
      return "7";
    case "NINETY_DAYS":
      return "90";
    case "ALL":
      return "all";
    case "THIRTY_DAYS":
      return undefined;
  }
}

export function trendBarHeight(views: number, maximum: number): number {
  if (views <= 0 || maximum <= 0) return 0;
  return Math.max(4, (views / maximum) * 100);
}

export function latestAnalyticsUpdate(
  viewsUpdated: string | null | undefined,
  federationUpdated: string | null | undefined,
): string | null {
  if (viewsUpdated == null) return federationUpdated ?? null;
  if (federationUpdated == null) return viewsUpdated;
  return viewsUpdated > federationUpdated ? viewsUpdated : federationUpdated;
}
