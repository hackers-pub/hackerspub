import { useLocation } from "@solidjs/router";

export function pathMatches(
  pathname: string,
  href: string,
  exact = false,
): boolean {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return path === href || (!exact && path.startsWith(`${href}/`));
}

/**
 * Reactive form of `pathMatches` bound to the router location. Returns a
 * predicate for marking navigation links as active:
 *
 * ```tsx
 * const activePath = useActivePath();
 * <A href="/feed" active={activePath("/feed", true)} />
 * ```
 */
export function useActivePath(): (href: string, exact?: boolean) => boolean {
  const location = useLocation();
  return (href, exact = false) => pathMatches(location.pathname, href, exact);
}
