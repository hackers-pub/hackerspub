# web-next performance follow-ups

Captured during a Firefox-profiler investigation of `/feed` interactive
memory growth (peak +10 MB/s during interaction; ~0 MB/s when idle).

The shipped fix in this branch addresses two CPU/allocation hotspots:

- `LanguageSelect.tsx` re-running a 200-entry `Intl.DisplayNames` map on
  every reactive read (`locales` was a plain function, not a memo).
- `Intl.RelativeTimeFormat` allocated per `Timestamp` render across all
  visible timestamps.

This file lists what's left after that, in priority order.

## Blocked on upstream

### Make `<Show keyed>` over a Relay fragment stop re-mounting on field updates

Profiles showed `_$createComponent` dominating leaf samples during
interaction. The mounted Kobalte primitives (Tooltip, Popover,
DropdownMenu, HoverCard) were being destroyed and rebuilt every time a
Relay fragment snapshot changed — even on pure field updates such as a
reaction toggle or a polled count delta.

Root cause is in `solid-relay@1.0.0-beta.25`. `createFragment`
pre-clears `data` to `undefined` immediately before applying its
identity-preserving `reconcile({ key: "__id", merge: true })`. Because
Solid's `reconcile` early-exits to "return the new value as-is" when
the current state isn't wrappable (see `solid-js/store`
`modifiers.ts`), the pre-clear guarantees a fresh top-level reference
every snapshot. `<Show keyed when={data()}>` then sees a new identity
on every Relay tick and re-mounts the subtree wholesale.

The local lint plugin `web-next/lint-plugins/keyed-show.ts` correctly
enforces `keyed` for solid-relay-backed accessors (non-keyed risks the
documented "Stale read from `<Show>`" race when a fragment flips to
null inside the same tick as a downstream reactive read), so the right
fix is upstream rather than relaxing the rule.

Upstream patch proposed at <https://github.com/XiNiHa/solid-relay/pull/68>
(branch: `nyanrus/solid-relay@fix/reconcile-preserve-identity`).

Once that ships, `keyed` Shows in this codebase will only re-mount on
actual record changes, with no code changes required here. As an
interim, this could be vendored via a pnpm patch
(`pnpm-workspace.yaml#patchedDependencies` — the workspace already
patches `@kobalte/core`, `@solidjs/start`, and `solid-js`).

## High-impact, structural

### Lazy-mount Tooltips in `PostEngagementBar`

The bar's `SplitControl` (×3 per card: Quote / Share / icon-only
triggers) and `ReplyControl` each wrap their button in a Kobalte
`<Tooltip>`. With ~25 posts visible on a timeline that's roughly **100
Tooltip primitives mounted at all times**, each carrying FloatingUI,
Portal, Presence, DismissableLayer, and hover-delay timers.

The tooltip text is the same string already in `aria-label`, so the
primitive's only real user value is the desktop-only hover label.

Options:

- Lazy-mount: gate `<Tooltip>` behind a `hovered()` signal flipped on
  `onPointerEnter` / `onFocusIn`, the same pattern already used for the
  emoji popover (`emojiPickerMounted`). Mount count: 100 → 0–few.
- Drop Kobalte tooltip and rely on native `title=""`. Zero JS, slower
  show, no portal/positioning, identical screen-reader behaviour.

Call sites: `src/components/PostEngagementBar.tsx` (`ReplyControl` line
~568, `SplitControl` line ~611). Same pattern in `VisibilityTag.tsx`
and `ProfileCard.tsx`.

### Lazy-mount `ActorHoverCard`

`ActorHoverCard` wraps every author avatar (×25) plus every `@mention`
inside post bodies. Each instance keeps a Kobalte `HoverCard` primitive
mounted, even though the *loader* inside is correctly already gated by
`<Show when={open()}>`.

Suggested shape: wrap the children in a `<span>` that flips a
`hovered()` signal on `onPointerEnter`/`onFocusIn`, then render the
`HoverCard` inside `<Show when={hovered()}>` with the same children as
fallback.

Call sites: `src/components/ActorHoverCard.tsx`. Used heavily by
`NoteHeader`, `PostAvatar`, `mentionHoverCards`.

## Medium-impact, mechanical

### Replace `ui/skeleton.tsx` with a plain element

Kobalte's `Skeleton` primitive emits roughly `<div role="status"
aria-busy="true" data-skeleton>`. The 18 in-app uses are all decorative
shapes (`<Skeleton class="h-3 w-1/2 rounded" />`). Replacing the
wrapper with a plain `<div aria-busy="true" class={...} />` removes a
Kobalte dependency edge for ~zero a11y loss.

Call sites: `src/components/ui/skeleton.tsx` (the wrapper) and 18
in-app imports.

### Replace `ui/separator.tsx` with `<hr>`

Kobalte's `Separator` is essentially `<hr role="separator"
aria-orientation="…">`. Native `<hr>` carries the same a11y semantics
by default. One call site (`ui/sidebar.tsx`); not worth a dedicated
change but pick it up if touching that area.

## Low-impact, optional

### Drop `Button` wrapper for non-polymorphic uses

`ui/button.tsx` goes through Kobalte `ButtonPrimitive` + `Polymorphic`.
For the majority of call sites that don't use `as={A}` / `as={…}`, a
plain `<button>` with the same class string works identically. ~46
call sites; mostly mechanical but high churn for small gain.

## Out of scope of this audit

The following Kobalte primitives are appropriate where used and should
stay:

- `Dialog`, `AlertDialog` — focus trap, scroll lock, escape, portal.
- `Popover` — interactive floating UI with dismissable layer.
- `DropdownMenu` — roving tabindex + type-ahead + ARIA menu.
- `Combobox`, `Select` — type-ahead, virtualization, ARIA combobox.
- `Tabs`, `Toast`, `TextField`, `Checkbox`, `MarkdownEditor`,
  `OtpField`.

## Verification

After any of the above lands, rerun the same Firefox-profiler scenario
(30 s on `/feed` with one composer open/close and one reaction toggle).
Compare:

- hackers.pub heap growth (target: stays under ~1 MB/s during
  interaction; was +10 MB/s before the shipped fix).
- `_$createComponent` appearance in the leaf-sample list (target: not
  in the top 25 during steady-state interaction).
- Total Kobalte chunk inclusive samples (target: meaningfully lower
  than the ~1,200 inclusive samples observed pre-fix on
  `@kobalte/core/dist/chunk/*`).
