<!-- deno-fmt-ignore-file -->

Hackers' Pub Design System
==========================

This document describes the visual language, design tokens, and UI patterns
used by the Hackers' Pub web application in `web-next/`.


Design philosophy
-----------------

Hackers' Pub is a place for hackers to share knowledge.  Its visual
language follows from that purpose:

 -  *Black and white first.* The interface is achromatic by default. Color
    appears only where it carries meaning—semantic states (success,
    warning, error, info) and the tint applied to mentions and links.
 -  *Content over chrome.* Posts, articles, and conversations are the
    product. UI elements stay quiet so that prose, code blocks, and media
    do the talking.  Borders and a single low-elevation shadow do most of
    the structural work; gradients, large drop shadows, and filled
    backgrounds are avoided.
 -  *Modern but unfussy.* The product looks contemporary—generous
    whitespace, soft radii, subtle hover states—without chasing trends.
    No glassy bevels, no neumorphism, no decorative illustration outside
    the brand mark itself.
 -  *Readable in any locale.* Every layout has to work for Korean,
    Japanese, Simplified Chinese, Traditional Chinese, and English at the
    same time.  Type, line-height, and inline spacing are chosen with CJK
    text in mind.
 -  *Respects the system.* Light and dark themes both ship.  The site
    follows `prefers-color-scheme`; there is no manual toggle.


Visual identity
---------------

Brand assets are maintained in a separate repository:
<https://github.com/hackers-pub/visual-identity>.  They are licensed
[CC-BY-SA 4.0] and credited to designer Bak Eunji.

[CC-BY-SA 4.0]: https://creativecommons.org/licenses/by-sa/4.0/

### Pubnyan, the mascot

The black-and-white cat is *Pubnyan* (펍냥이).  Three motifs encode
the project's values:

 -  The *cat* stands for the curious, independent character of hackers,
    who have long claimed cats as a mascot.
 -  The *star-shaped mouth* signals the *fediverse*—a federated
    universe of independent servers connected by ActivityPub.
 -  The *orbital ring* around the body reinforces the cosmic theme and
    visually reads as connection and interoperability.

Pubnyan ships in five expressions, each available with transparent,
white, black, or outlined backgrounds:

| Variant   | Use                                         |
| :-------- | :------------------------------------------ |
| `normal`  | Default mark, branding, OG images           |
| `curious` | Discovery, search, exploration empty states |
| `shy`     | Onboarding, gentle prompts                  |
| `cry`     | Errors, empty timelines, failure states     |
| `angry`   | Rate limits, blocked actions, moderation    |

A separate `starorbit` mark—the star and ring without the cat—is
used as a compact symbol where Pubnyan is too detailed (small favicons,
inline UI icons, social previews).

### Logotype

Two logotypes are provided:

 -  *Full* — `HACKERS'PUB`. The default.
 -  *Short* — `HCKS'PUB`. For very narrow contexts (small avatars,
    favicons, square OG crops).

Both are hand-drawn, all-caps, with a curly typographic apostrophe.  The
hand-drawn lettering is intentional contrast against the otherwise
geometric UI—it gives the brand warmth without coloring the rest of
the interface.

In the app, the logotype appears in the sidebar header and the mobile
top bar via `/logo-light.svg` and `/logo-dark.svg` (see
`web-next/src/components/AppSidebar.tsx`).  Always use a `<picture>`
element to swap between the two based on `prefers-color-scheme` rather
than CSS filters.

### Brand colors

The brand operates in pure black and white:

 -  `#000000` — primary on light surfaces; background of dark sticker
    and avatar variants.
 -  `#FFFFFF` — primary on dark surfaces; fill of the cat, the star,
    and the orbit.

There is no brand accent color.  When the UI needs to express a state,
it does so through the semantic palette below, not through brand color.


Color system
------------

The runtime color system is defined in
`web-next/src/app.css` as CSS custom properties in the [OKLCH][] color
space.  Every token in the surface and content table below is
achromatic (chroma `0`); chroma is reserved for the semantic tokens
and for the `--chart-1`…`--chart-5` data-visualization palette that
the project inherits unchanged from shadcn's defaults.  Tokens are
exposed to Tailwind via `@theme inline`—every `--background` is
reachable as `bg-background`, `text-background`, `border-background`,
etc.

> [!NOTE]
> *app.css* also still ships shadcn's default `--sidebar-primary`
> token, which in dark mode resolves to a saturated blue
> (`oklch(0.488 0.243 264.376)`).  Nothing in the product currently
> renders it; treat it as a legacy default that should not be used by
> new components.

[OKLCH]: https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/oklch

### Surface and content tokens

Pairs are listed `light / dark`.

| Token                  | Light value        | Dark value         | Use                                         |
| :--------------------- | :----------------- | :----------------- | :------------------------------------------ |
| `background`           | `oklch(1 0 0)`     | `oklch(0.145 0 0)` | Page background                             |
| `foreground`           | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | Default text                                |
| `card`                 | `oklch(1 0 0)`     | `oklch(0.145 0 0)` | Card surface (same as background by design) |
| `card-foreground`      | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | Text inside cards                           |
| `popover`              | `oklch(1 0 0)`     | `oklch(0.145 0 0)` | Popovers, dropdowns, dialogs                |
| `popover-foreground`   | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | Text inside popovers                        |
| `primary`              | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` | Default action surface (inverted from bg)   |
| `primary-foreground`   | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` | Text on primary                             |
| `secondary`            | `oklch(0.97 0 0)`  | `oklch(0.269 0 0)` | Secondary actions, subtle filled surfaces   |
| `secondary-foreground` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` | Text on secondary                           |
| `muted`                | `oklch(0.97 0 0)`  | `oklch(0.269 0 0)` | Muted backgrounds (e.g., article footers)   |
| `muted-foreground`     | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` | De-emphasized text (handles, timestamps)    |
| `accent`               | `oklch(0.97 0 0)`  | `oklch(0.269 0 0)` | Hover backgrounds                           |
| `accent-foreground`    | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` | Text on accent                              |
| `border`               | `oklch(0.922 0 0)` | `oklch(0.269 0 0)` | Hairlines between rows and cards            |
| `input`                | `oklch(0.922 0 0)` | `oklch(0.269 0 0)` | Form field borders                          |
| `ring`                 | `oklch(0.708 0 0)` | `oklch(0.439 0 0)` | Focus ring                                  |

Note that `card`, `popover`, and `background` deliberately share the
same value.  Hierarchy is created by *borders*, not by stacked surfaces—this
is what gives the UI its flat, paper-like quality.

### Semantic palette

Semantic tokens come in `*` (background) and `*-foreground` (text)
pairs.  For `info`, `success`, `warning`, and `error`, backgrounds are
very low chroma and foregrounds carry the saturated hue; dark mode
inverts the lightness but preserves the hue, so the same tinted-panel
treatment works on either theme.  `destructive` is the exception: it
is a saturated, high-chroma red used as a button fill (paired with
`destructive-foreground` for the label), not a tinted alert
background, and is documented here only because the `Button` variant
of the same name reaches for it.

| Token         | Hue           | Use                                            |
| :------------ | :------------ | :--------------------------------------------- |
| `info`        | ~237° (blue)  | Neutral information, link verification         |
| `success`     | ~162° (green) | Confirmed state, verified links                |
| `warning`     | ~48° (amber)  | Reversible warnings                            |
| `error`       | ~26° (red)    | Hard errors, validation failures               |
| `destructive` | ~27° (red)    | Destructive button variants (delete, sign out) |

Use semantic tokens via the `Badge` variants (`success`, `warning`,
`error`) and the `Button` variant `destructive`.  Avoid hand-rolling
colored elements; if you need a new semantic, add it to `app.css` and
expose it through `@theme inline`.

### Sidebar palette

The sidebar has its own mirrored set of tokens (`--sidebar`,
`--sidebar-foreground`, …).  In light mode the sidebar
(`oklch(0.985 0 0)`) is one notch *darker* than the page
(`oklch(1 0 0)`); in dark mode the sidebar (`oklch(0.205 0 0)`) is one
notch lighter than the page (`oklch(0.145 0 0)`).  Either way it sits
one step away from the page in the direction that gives it a subtle
separation without introducing a true second surface.

### Prose color callouts

Markdown alerts inside articles inherit GitHub's callout palette,
defined locally in `app.css`:

| Type        | Light hex | Dark hex  |
| :---------- | :-------- | :-------- |
| `note`      | `#0969da` | `#2f81f7` |
| `tip`       | `#1a7f37` | `#3fb950` |
| `warning`   | `#9a6700` | `#d29922` |
| `severe`    | `#bc4c00` | `#db6d28` |
| `caution`   | `#d1242f` | `#f85149` |
| `important` | `#8250df` | `#a371f7` |

These are intentionally *not* part of the OKLCH design tokens—they
are content colors, not UI colors, and they need to match GitHub-style
expectations one-to-one.


Typography
----------

### Font

The single typeface is **[Pretendard Variable]**, declared as
`--font-sans` in `@theme inline` and applied to `body` by default.
Pretendard is chosen because it covers Latin, Hangul, Kana, and CJK
ideographs in a single variable file, with consistent metrics across
scripts—important for an interface that mixes English, Korean, and
Japanese in the same line.

There is no separate display font; the brand wordmark already provides
display character.  For inline code and `<pre>` blocks, the browser
default monospace stack is used and recolored by Shiki at render time.

[Pretendard Variable]: https://github.com/orioncactus/pretendard

### Type scale

The product uses Tailwind's default type scale unchanged.  Common roles:

| Role                          | Tailwind classes                                    |
| :---------------------------- | :-------------------------------------------------- |
| Page / article title          | `text-xl font-semibold` (article cards)             |
| Profile name                  | `text-xl font-semibold`                             |
| Card title                    | `text-lg font-semibold leading-none tracking-tight` |
| Body                          | inherits — 16px / `1.5` line-height                 |
| Card description / metadata   | `text-sm text-muted-foreground`                     |
| Timestamps, handle suffixes   | `text-sm text-muted-foreground/70`                  |
| Inline labels (badges, hints) | `text-xs font-semibold` (badges) / `text-xs`        |

### Long-form content (`prose`)

Articles and bios render through `@tailwindcss/typography` with the
`prose` (light) and `dark:prose-invert` (dark) classes.  `app.css`
extends the defaults in a few specific places:

 -  **Mentions** (`a.mention:not(.hashtag)`) get a 10% tinted background
    and border in the link color, with the display name de-emphasized to
    50% opacity beside the handle.  On hover, the tint deepens to 15%.
 -  **Header anchors** (`.header-anchor`) sit at 50% opacity and reveal
    a `#` only on hover.
 -  **Inline code** drops its bold weight and quote marks, and uses a
    translucent neutral background (`rgba(101, 117, 133, 0.25)`).
 -  **Shiki code blocks** support `.highlighted`, `.focused`, and
    `.diff` line decorations, plus diff `add`/`remove` markers.
 -  **Quote-back fragments** at the end of federated notes
    (`.quote-inline`, `.reference-link-inline`) are hidden so the
    reading view stays clean.


Spacing, radii, and elevation
-----------------------------

### Radii

A single base radius is exposed and stepped:

| Token       | Value                       | Pixel value |
| :---------- | :-------------------------- | :---------- |
| `--radius`  | `0.5rem`                    | 8 px        |
| `radius-sm` | `calc(var(--radius) - 4px)` | 4 px        |
| `radius-md` | `calc(var(--radius) - 2px)` | 6 px        |
| `radius-lg` | `var(--radius)`             | 8 px        |
| `radius-xl` | `calc(var(--radius) + 4px)` | 12 px       |

Use `rounded-md` for buttons and badges, `rounded-lg` for cards and
modals, `rounded-full` for avatars, scrollbar thumbs, and the floating
compose button.

### Shadows

Only one elevation level is in active use: `shadow-sm` on `Card`.
Sheets, popovers, and dialogs rely on a backdrop and border for
separation rather than larger shadows.  If you reach for `shadow-lg` or
similar, reconsider—a border or a `bg-muted` panel almost always reads
better in this design.

### Container

The `container` utility is overridden in `app.css`:

 -  Default padding: `px-8`.
 -  Below 640 px: `px-4`.
 -  At and above the `sm` breakpoint: `max-width: none`—content
    expands to fill, framed by the sidebar rather than centered with
    margins.

### Scrollbars

`::-webkit-scrollbar` is restyled site-wide: 16 px wide track,
`rounded-full` thumb that uses `bg-accent` with a 4 px transparent
border (via `bg-clip-content`) so it floats inside the gutter.  The
corner is hidden.  Firefox uses its native styling.

### Transitions

Stick to Tailwind's `transition-colors` for hover/focus changes—most
of the interface only animates color and background.  Animated open/close
states (accordion, popover, sheet) use the `tw-animate-css` plugin and
the locally-defined `accordion-down`, `accordion-up`, `content-show`,
and `content-hide` keyframes in `app.css`.


Iconography
-----------

### Inline SVG icons

The application uses [Heroicons] *outline* style icons, inlined as SVG
into components rather than imported from a library.  This keeps SSR
output minimal and lets icons inherit `currentColor` cleanly.

Conventions:

 -  `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`,
    `stroke-width="1.5"`.
 -  `stroke-linecap="round"` and `stroke-linejoin="round"`.
 -  Default size class is `size-6` (24 px) for navigation, `size-4`
    (16 px) inside buttons and labels, `size-3.5` (14 px) for inline
    list bullets.

[Heroicons]: https://heroicons.com/

### Lucide icons

For UI primitives generated by shadcn/ui (chevrons, X, check, dots),
[Lucide] is configured as the icon library (`components.json`).  Use
Lucide only for those primitives; for app-level navigation prefer
Heroicons inline so the visual weight stays consistent.

[Lucide]: https://lucide.dev/

### Service icons

Profile link rows use small monochrome icons for external services,
served from `/icons/{service}.svg` (e.g. `web.svg`, `github.svg`).
They are rendered at `size-3.5` with `opacity-65`, and inverted under
dark mode via `dark:invert`.


Components and patterns
-----------------------

### solid-ui (New York style)

The component library is *[solid-ui]*—the SolidJS port of
shadcn/ui—configured in the *New York* style.  Source lives under
`web-next/src/components/ui/`.  Each primitive is generated from the
solid-ui CLI and then committed to this repo, so it is fine (and
expected) to edit the files directly when product needs diverge from
the upstream defaults.

solid-ui builds on [Kobalte] for the underlying headless behavior —
that is why you will see `@kobalte/core` imports inside the primitives.
Treat Kobalte as an implementation detail of solid-ui rather than a
component library you reach for on its own; if you need a new
primitive, add it through solid-ui first and only drop down to Kobalte
when no equivalent recipe exists.

[solid-ui]: https://www.solid-ui.com/
[Kobalte]: https://kobalte.dev/

### Buttons

`Button` (see `components/ui/button.tsx`) exposes six variants and four
sizes:

| Variant       | Visual                                            |
| :------------ | :------------------------------------------------ |
| `default`     | `bg-primary text-primary-foreground` — strong CTA |
| `destructive` | `bg-destructive` — destructive CTA                |
| `outline`     | Border, transparent fill, accent on hover         |
| `secondary`   | `bg-secondary` — quiet CTA                        |
| `ghost`       | No chrome, accent on hover — toolbar buttons      |
| `link`        | Underlined text only                              |

Sizes: `default` (h-10), `sm` (h-9), `lg` (h-11), `icon` (size-10).
Buttons enforce focus-visible rings (`ring-2 ring-ring`) and a 50%
disabled opacity; do not override these.

### Cards and posts

The repository has two distinct “card” idioms; do not mix them.

 -  **`Card`** (the shadcn primitive, `components/ui/card.tsx`) — a
    bordered box with `rounded-lg`, `shadow-sm`, and `p-6` for the
    header and footer.  Used for settings panes, dialogs, and structured
    content blocks.
 -  **Post cards** (`PostCard`, `NoteCard`, `ArticleCard`,
    `QuestionCard`) — *not* boxed.  They are rows in a list, separated
    only by a bottom border (`border-b last:border-none`) and pick up a
    very subtle hover background (`hover:bg-muted/30` or
    `bg-muted/40`).  Article cards add a `bg-muted` “Read full article”
    footer with a top border.  This list-style treatment is the visual
    spine of the timeline and profile pages.

When you build a new feed-like surface, follow the post-card pattern
(border-b rows, no individual chrome).  When you build a new
configuration page, follow the `Card` pattern.

### Badges

`Badge` provides `default`, `secondary`, `outline`, plus the semantic
`success`, `warning`, and `error` variants.  Toggle the `round` prop for
a pill shape.  Badges are intentionally text-first—they should stay
under 20 characters and never replace a button.

### Sidebar

The application shell is a `Sidebar` (the solid-ui sidebar primitive,
see `components/ui/sidebar.tsx`).  Constants:

 -  Desktop width: `16rem`.
 -  Mobile sheet width: `18rem`.
 -  Collapsed icon-rail width: `3rem`.
 -  Mobile breakpoint: `768px` (Tailwind's `md`).
 -  Open/closed state persists in the `sidebar:state` cookie for one
    week.
 -  Keyboard shortcut: <kbd>⌃B</kbd>/<kbd>⌘B</kbd> toggles the sidebar (constant
    `SIDEBAR_KEYBOARD_SHORTCUT = "b"`).

The sidebar groups navigation under sentence-cased labels (`Timeline`,
`Account`, `Compose`, `Recent drafts`).  Items use `SidebarMenuButton`
with a leading 24 px icon and a flush-left text label.  The footer holds
legal links and the mobile-app callouts.

### Mobile top bar

Below `md`, a fixed header (`h-14`, `bg-background/80 backdrop-blur`,
`border-b`) carries a `SidebarTrigger` on the left, the wordmark
centered, and a 36 px placeholder on the right to keep the mark
optically centered.  See `routes/(root).tsx`.

### Toasts

Use the local `Toaster` (`components/ui/toast.tsx`) mounted once in the
root layout.  Toasts inherit the same surface tokens and should be the
only place we report transient outcomes; do not pop `window.alert`
except for true sign-out style failures (see `AppSidebar.tsx` for the
exception).


Layout
------

### Page structure

A signed-in page is composed of:

~~~~
┌──────────────┬──────────────────────────────────────────────────┐
│              │                                                  │
│              │                                                  │
│  AppSidebar  │  <main> route content                            │
│   (16rem)    │                                                  │
│              │                                                  │
└──────────────┴──────────────────────────────────────────────────┘
~~~~

The `<main>` element gets `lang={i18n.locale.minimize().baseName}` so
typographic rules for the active language (line-breaking, quotation
marks) apply automatically.  In development, `dev-bg-light.svg` /
`dev-bg-dark.svg` watermarks are tiled into the main background to make
the development environment unmistakable.

### Content widths

Two helpers wrap route content:

 -  `NarrowContainer` — for reading surfaces (single article, profile,
    settings).
 -  `WideContainer` — for index/listing surfaces (timelines, search
    results).

Use them rather than ad-hoc `max-w-*` values so widths stay consistent.

### Compose

A floating compose button (`FloatingComposeButton`) sits bottom-right on
mobile and small viewports.  When `main` content can be obscured by it,
the layout adds `pb-24 md:pb-0` to make room.


Internationalization in design
------------------------------

All visible strings go through Lingui (`useLingui` and the `t`
template-tag macro).  See `AGENTS.md` for the developer workflow.  A few
design implications worth keeping in mind:

 -  Labels are translated, not iconified—every nav item has a text
    label beside its icon, and icon-only buttons must carry an
    `aria-label`.
 -  The site language is selectable via `?lang={locale}` or
    `Accept-Language`, and the `lang` attribute is set on the `<main>`
    element accordingly (see `routes/(root).tsx`).  Avoid hard-coding
    font features that depend on language; let Pretendard handle it.
 -  Text expansion is real.  Reserve room for German-style runs and for
    Japanese particles that lengthen a string by one or two characters.
    Test new layouts in at least English, Korean, and Japanese.


Dark mode
---------

Dark mode follows `prefers-color-scheme: dark` exclusively—there is
no manual toggle.  All component variants must therefore work in both
themes without per-instance overrides.

Patterns that need attention:

 -  Use semantic tokens (`bg-muted`, `text-muted-foreground`,
    `border`), never hard-coded grays.
 -  Use `dark:prose-invert` whenever rendering Markdown.
 -  Apply `dark:invert` to monochrome SVG content icons that are
    drawn black-on-transparent (e.g., the service icons in
    `ProfileCard`).  Do *not* apply it to brand assets—swap the
    light/dark logo via `<picture>` instead.
 -  Test new components by toggling the OS theme; do not rely on a
    `.dark` class.  Note that `app.css` still carries a small
    `.dark, [data-kb-theme="dark"]` block of legacy HSL `--sidebar-*`
    tokens left over from the shadcn defaults; treat it as
    compatibility shim and route new work through the OKLCH tokens
    (which already switch on `prefers-color-scheme`) instead of adding
    to it.


Resources
---------

### Within this repo

 -  `web-next/src/app.css` — color tokens, typography, prose extensions,
    scrollbar and container overrides.
 -  `web-next/src/components/ui/` — solid-ui primitives (button, card,
    badge, sidebar, toast, …).
 -  `web-next/src/components/` — application-level components (post
    cards, profile card, sidebar, compose flow).
 -  `web-next/components.json` — solid-ui / shadcn configuration
    (style, base color, icon library).
 -  `web-next/public/logo-light.svg`, `logo-dark.svg`,
    `favicon.svg`, `manifest.json` — runtime brand assets.

### External

 -  Visual identity repository:
    <https://github.com/hackers-pub/visual-identity>
 -  solid-ui: <https://www.solid-ui.com/>
 -  shadcn/ui (the upstream design language): <https://ui.shadcn.com/>
 -  Kobalte (headless primitives under solid-ui): <https://kobalte.dev/>
 -  Tailwind CSS v4: <https://tailwindcss.com/>
 -  Pretendard: <https://github.com/orioncactus/pretendard>
 -  Heroicons: <https://heroicons.com/>
 -  Lucide: <https://lucide.dev/>
