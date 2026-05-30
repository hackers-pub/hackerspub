import { useLocation, useSearchParams } from "@solidjs/router";

export type NewsSort = "POPULAR" | "NEWEST" | "ALL_TIME";

const SLUG_TO_SORT: Record<string, NewsSort> = {
  popular: "POPULAR",
  newest: "NEWEST",
  "all-time": "ALL_TIME",
};

const SORT_TO_SLUG: Record<NewsSort, string> = {
  POPULAR: "popular",
  NEWEST: "newest",
  ALL_TIME: "all-time",
};

function parseSort(value: string | undefined): NewsSort {
  return (value != null && SLUG_TO_SORT[value]) || "POPULAR";
}

/**
 * Encapsulates the `?sort=` search-param handling for the news feed (mirrors
 * `useLanguageFilter`).  `initialSort` is captured non-reactively so the
 * initial preloaded query reference stays stable across sort-pill clicks;
 * subsequent changes are handled by a fragment-level refetch inside `NewsList`.
 */
export function useNewsSort(basePath: string) {
  const location = useLocation();
  const [searchParams] = useSearchParams<{ sort?: string }>();

  const initialSort = parseSort(searchParams.sort);
  const activeSort = () => parseSort(searchParams.sort);

  const buildHref = (sort: NewsSort) => {
    const p = new URLSearchParams(location.search);
    if (sort === "POPULAR") p.delete("sort");
    else p.set("sort", SORT_TO_SLUG[sort]);
    const qs = p.toString();
    return basePath + (qs ? "?" + qs : "");
  };

  return { activeSort, initialSort, buildHref };
}
