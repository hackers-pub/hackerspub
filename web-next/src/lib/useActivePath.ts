import { useLocation } from "@solidjs/router";

export interface ActivePathOptions {
  /**
   * Match `href` alone, not the paths below it. For a section whose sub-pages
   * all have navigation entries of their own.
   */
  readonly exact?: boolean;
  /**
   * Sub-paths that have an entry of their own. `href` stays inactive on them
   * and below them, so only the more specific entry lights up. For a section
   * where just some sub-pages are listed separately; `exact` covers the rest.
   */
  readonly except?: readonly string[];
}

export function pathMatches(
  pathname: string,
  href: string,
  options: ActivePathOptions = {},
): boolean {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (options.except?.some((sub) => pathMatches(path, sub))) return false;
  return path === href || (!options.exact && path.startsWith(`${href}/`));
}

/**
 * Reactive form of `pathMatches` bound to the router location. Returns a
 * predicate for marking navigation links as active:
 *
 * ```tsx
 * const activePath = useActivePath();
 * <A href="/feed" active={activePath("/feed", { exact: true })} />
 * ```
 */
export function useActivePath(): (
  href: string,
  options?: ActivePathOptions,
) => boolean {
  const location = useLocation();
  return (href, options) => pathMatches(location.pathname, href, options);
}
