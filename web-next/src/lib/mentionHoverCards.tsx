import * as PopoverPrimitive from "@kobalte/core/popover";
import {
  type Accessor,
  batch,
  createEffect,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import {
  ActorHoverCardLoader,
  ActorHoverCardLoaderByUrl,
} from "~/components/ActorHoverCardLoader.tsx";
import { ACTOR_HOVER_SURFACE_CLASS } from "~/components/ui/hover-card.tsx";
import { cn } from "~/lib/utils.ts";

const OPEN_DELAY_MS = 400;
const CLOSE_DELAY_MS = 200;

/**
 * What the mention layer needs to fetch the actor.
 *
 * `kind: "url"` is preferred (the mention link's `href` is a stable
 * ActivityPub identifier we can resolve directly via the `actorByUrl`
 * query). `kind: "handle"` is the local-Markdown-renderer fast path:
 * `<a class="mention" data-username data-host …>` already carries the
 * canonical handle, so we skip the URL roundtrip.
 */
export type MentionLookup =
  | { kind: "handle"; value: string }
  | { kind: "url"; value: string };

export interface MentionHoverCardState {
  anchor: Accessor<HTMLElement | undefined>;
  lookup: Accessor<MentionLookup | undefined>;
  open: Accessor<boolean>;
  setOpen: (open: boolean) => void;
  onContentEnter: () => void;
  onContentLeave: () => void;
}

/**
 * Attach hover-card behavior to all `<a class="mention">` elements rendered
 * inside the given container. The container's `innerHTML` may be set from a
 * server-rendered Markdown string.
 *
 * The container ref is read reactively, so callers may pass a signal accessor
 * whose value is `undefined` until the container mounts (e.g., when wrapped
 * in a `<Show>`).
 */
export function useMentionHoverCards(
  getEl: Accessor<HTMLElement | undefined>,
): MentionHoverCardState {
  const [anchor, setAnchor] = createSignal<HTMLElement | undefined>();
  const [lookup, setLookup] = createSignal<MentionLookup | undefined>();
  const [open, setOpen] = createSignal(false);

  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelOpen = () => {
    if (openTimer !== undefined) {
      clearTimeout(openTimer);
      openTimer = undefined;
    }
  };
  const cancelClose = () => {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  };

  /**
   * Resolve a hovered mention element to a way of looking up the actor.
   *
   * Two source markups are supported:
   *
   * 1. The local Markdown renderer (see `models/markup.ts`) emits
   *    `<a class="u-url mention" data-username data-host …>`. We can build
   *    the handle directly and use the `actorByHandle` query.
   * 2. Federated content (e.g., notes received over ActivityPub) typically
   *    uses Mastodon-style h-card markup
   *    `<span class="h-card"><a class="u-url mention" href="…">@user</a></span>`
   *    without data attributes. The `href` is the actor's URL/IRI; resolve
   *    it directly through `actorByUrl` so we don't have to guess the
   *    handle from path-segment heuristics.
   */
  const resolveMention = (
    target: EventTarget | null,
  ): { el: HTMLElement; lookup: MentionLookup } | undefined => {
    const t = target as Element | null;
    if (!t?.closest) return undefined;
    const a = t.closest(
      "a.mention:not(.hashtag)",
    ) as HTMLElement | null;
    if (!a) return undefined;

    const dsUsername = a.getAttribute("data-username");
    const dsHost = a.getAttribute("data-host");
    if (dsUsername && dsHost) {
      return {
        el: a,
        lookup: { kind: "handle", value: `@${dsUsername}@${dsHost}` },
      };
    }

    const href = a.getAttribute("href");
    if (!href) return undefined;
    // Protocol-relative URLs (`//host/path`) need a base to parse; treat
    // them as `https:` to keep the host. Matches `parseContentAnchorUrl`
    // in `models/html.ts`.
    const parseTarget = href.startsWith("//") ? `https:${href}` : href;
    let url: URL;
    try {
      url = new URL(parseTarget);
    } catch {
      return undefined;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return { el: a, lookup: { kind: "url", value: url.href } };
  };

  const onPointerOver = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const m = resolveMention(e.target);
    if (!m) return;
    // Pointer movement between child nodes of the same mention reports the
    // same `closest("a.mention")`; skip those so we don't restart the open
    // delay every time the cursor crosses an inner img/span boundary.
    const from = e.relatedTarget as Node | null;
    if (from && m.el.contains(from)) return;
    cancelClose();
    if (anchor() === m.el && open()) return;
    cancelOpen();
    openTimer = setTimeout(() => {
      // Apply anchor + lookup + open in one reactive cycle so the
      // Popover never sees a transitional combination of new anchor
      // with stale lookup data.
      batch(() => {
        setAnchor(m.el);
        setLookup(m.lookup);
        setOpen(true);
      });
      openTimer = undefined;
    }, OPEN_DELAY_MS);
  };

  const onPointerOut = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const m = resolveMention(e.target);
    if (!m) return;
    const into = e.relatedTarget as Node | null;
    if (into && m.el.contains(into)) return;
    cancelOpen();
    cancelClose();
    closeTimer = setTimeout(() => {
      setOpen(false);
      closeTimer = undefined;
    }, CLOSE_DELAY_MS);
  };

  // Reactively (re-)attach listeners as the container element appears,
  // changes, or unmounts. createEffect's onCleanup runs before the effect
  // re-evaluates, so the previous element is detached cleanly.
  createEffect(() => {
    const el = getEl();
    if (!el) return;
    el.addEventListener("pointerover", onPointerOver, { passive: true });
    el.addEventListener("pointerout", onPointerOut, { passive: true });
    onCleanup(() => {
      el.removeEventListener("pointerover", onPointerOver);
      el.removeEventListener("pointerout", onPointerOut);
      // If a previous element is being detached while a hover-card cycle
      // is mid-flight, drop any pending timers so they can't reopen
      // against an anchor that is no longer in the live tree.
      cancelOpen();
      cancelClose();
      const a = anchor();
      if (a && el.contains(a)) {
        batch(() => {
          setOpen(false);
          setAnchor(undefined);
          setLookup(undefined);
        });
      }
    });
  });

  // Component-level cleanup for any pending timers.
  onCleanup(() => {
    cancelOpen();
    cancelClose();
  });

  return {
    anchor,
    lookup,
    open,
    setOpen,
    onContentEnter: () => {
      cancelClose();
    },
    onContentLeave: () => {
      cancelOpen();
      cancelClose();
      closeTimer = setTimeout(() => {
        setOpen(false);
        closeTimer = undefined;
      }, CLOSE_DELAY_MS);
    },
  };
}

export interface MentionHoverCardLayerProps {
  state: MentionHoverCardState;
}

export function MentionHoverCardLayer(props: MentionHoverCardLayerProps) {
  return (
    <PopoverPrimitive.Root
      open={props.state.open()}
      onOpenChange={props.state.setOpen}
      anchorRef={props.state.anchor}
      modal={false}
      gutter={4}
    >
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          class={cn(
            ACTOR_HOVER_SURFACE_CLASS,
            "origin-[var(--kb-popover-content-transform-origin)]",
          )}
          onPointerEnter={props.state.onContentEnter}
          onPointerLeave={props.state.onContentLeave}
          // Hover-card preview: don't yank focus into the popover when it
          // opens on pointer hover (Kobalte's Popover defaults to focusing
          // the first interactive element, which would blur whatever the
          // user was focused on; we just want a non-modal preview).
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Show when={props.state.lookup()}>
            {(lookup) => (
              <Show
                when={lookup().kind === "url"}
                fallback={<ActorHoverCardLoader handle={lookup().value} />}
              >
                <ActorHoverCardLoaderByUrl url={lookup().value} />
              </Show>
            )}
          </Show>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
