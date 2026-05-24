import { useNavigate } from "@solidjs/router";
import { type Accessor, createEffect, onCleanup } from "solid-js";

/**
 * Intercept clicks on `<a href="/...">` anchors inside a server-rendered
 * post-content container and route them through SolidJS client-side
 * navigation instead of triggering a full page reload.
 *
 * The backend (`transformMentions()` in `models/html.ts`, called from the
 * GraphQL `Post.content` and `ArticleContent.content` resolvers) rewrites
 * matched hashtag and mention links to local absolute paths. Plain `<a>`
 * elements created via `innerHTML` are not picked up by the router's link
 * interception, so we attach our own capture-phase click handler — capture
 * phase runs before any inline `onclick` attribute the backend may have set
 * for non-JS legacy paths, so `stopPropagation()` cleanly suppresses the
 * legacy fallback's `location.href = ...` full-page reload.
 *
 * Modifier-clicks (Cmd/Ctrl/Shift/Alt) and non-primary buttons fall through
 * so the browser's "open in new tab / new window" behavior keeps working.
 * Anchors with an explicit `target` other than `_self` are likewise left
 * alone — those are external links the backend marked for `_blank`.
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
      const a = (e.target as Element | null)?.closest<HTMLAnchorElement>(
        "a[href]",
      );
      if (!a || !el.contains(a)) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      const target = a.getAttribute("target");
      if (target && target !== "_self") return;
      e.preventDefault();
      e.stopPropagation();
      navigate(href);
    };
    el.addEventListener("click", onClick, true);
    onCleanup(() => el.removeEventListener("click", onClick, true));
  });
}
