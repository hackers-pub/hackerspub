import { useNavigate } from "@solidjs/router";
import { type Accessor, createEffect, onCleanup } from "solid-js";

/**
 * Intercept clicks on backend-tagged anchors inside a server-rendered
 * post-content container and route them through SolidJS client-side
 * navigation instead of letting the browser do a full page load.
 *
 * The backend (`transformMentions()` in `models/html.ts`, called from the
 * GraphQL `Post.content` and `ArticleContent.content` resolvers) marks
 * mention and hashtag links with `data-internal-href` pointing at the
 * canonical Hackers' Pub route. For hashtags it also overwrites `href`
 * with the local path; for mentions it leaves `href` as the remote
 * permalink so that right-click → Copy URL still yields the original
 * federated profile URL.
 *
 * Plain `<a>` elements created via `innerHTML` are not picked up by the
 * router's automatic link interception, so we attach a capture-phase click
 * handler and stop the browser's full-page navigation for internal routes.
 *
 * Targets, in order of precedence:
 *   1. `data-internal-href` (mention/hashtag rewritten by the backend) —
 *      use that value so mentions go to the local profile even though
 *      their `href` is still the remote URL.
 *   2. Local `href` (starts with `/` but not `//`) — generic in-app link
 *      embedded in content.
 *
 * Modifier-clicks (Cmd/Ctrl/Shift/Alt) and non-primary buttons fall
 * through so the browser's "open in new tab / new window" behavior keeps
 * working. Anchors with an explicit `target` other than `_self` are
 * likewise left alone.
 */
export function useContentLinkInterceptor(
  getEl: Accessor<HTMLElement | undefined>,
): void {
  const navigate = useNavigate();
  createEffect(() => {
    const el = getEl();
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const a = (e.target as Element | null)?.closest<HTMLAnchorElement>("a");
      if (!a || !el.contains(a)) return;
      const target = a.getAttribute("target");
      if (target && target !== "_self") return;
      const internalHref = a.getAttribute("data-internal-href");
      if (internalHref) {
        e.preventDefault();
        e.stopPropagation();
        navigate(internalHref);
        return;
      }
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      e.preventDefault();
      e.stopPropagation();
      navigate(href);
    };
    el.addEventListener("click", onClick, true);
    onCleanup(() => el.removeEventListener("click", onClick, true));
  });
}
