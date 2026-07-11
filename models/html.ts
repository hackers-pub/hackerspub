import { invert } from "@std/collections/invert";
import { escape, unescape } from "@std/html/entities";
import { load } from "cheerio";
import * as cssfilter from "cssfilter";
import xss from "xss";
import type * as xssType from "xss";
import { renderCustomEmojis } from "./emoji.ts";
import type { Actor } from "./schema.ts";

const { FilterXSS, whiteList } = xss as unknown as typeof xssType;

const htmlXss = new FilterXSS({
  allowList: {
    a: [
      "lang",
      "translate",
      "target",
      "href",
      "hreflang",
      "title",
      "rel",
      "class",
      "data-username",
      "data-host",
      "data-id",
      "data-iri",
      "data-internal-href",
      "id",
    ],
    abbr: ["lang", "translate", "title"],
    address: ["lang", "translate"],
    area: ["lang", "translate", "shape", "coords", "href", "alt"],
    article: ["lang", "translate"],
    aside: ["lang", "translate"],
    audio: [
      "lang",
      "translate",
      "autoplay",
      "controls",
      "crossorigin",
      "loop",
      "muted",
      "preload",
      "src",
    ],
    b: ["lang", "translate"],
    bdi: ["lang", "translate", "dir"],
    bdo: ["lang", "translate", "dir"],
    big: ["lang", "translate"],
    blockquote: ["lang", "translate", "cite"],
    br: ["lang", "translate"],
    caption: ["lang", "translate"],
    center: ["lang", "translate"],
    cite: ["lang", "translate"],
    code: ["lang", "translate"],
    col: ["lang", "translate", "align", "valign", "span", "width"],
    colgroup: ["lang", "translate", "align", "valign", "span", "width"],
    dd: ["lang", "translate"],
    del: ["lang", "translate", "datetime"],
    details: ["lang", "translate", "open"],
    dfn: ["lang", "translate"],
    div: ["lang", "translate", "class", "style"],
    dl: ["lang", "translate"],
    dt: ["lang", "translate"],
    em: ["lang", "translate"],
    figcaption: ["lang", "translate"],
    figure: ["lang", "translate"],
    font: ["lang", "translate", "color", "size", "face"],
    footer: ["lang", "translate"],
    h1: ["lang", "translate", "id"],
    h2: ["lang", "translate", "id"],
    h3: ["lang", "translate", "id"],
    h4: ["lang", "translate", "id"],
    h5: ["lang", "translate", "id"],
    h6: ["lang", "translate", "id"],
    header: ["lang", "translate"],
    hr: ["class"],
    i: ["lang", "translate"],
    img: [
      "lang",
      "translate",
      "src",
      "alt",
      "title",
      "width",
      "height",
      "loading",
    ],
    ins: ["lang", "translate", "datetime"],
    kbd: ["lang", "translate"],
    li: ["class", "id", "lang", "translate"],
    mark: ["lang", "translate"],
    nav: ["lang", "translate"],
    ol: ["class", "lang", "translate", "start"],
    p: ["class", "dir", "lang", "translate"],
    picture: ["lang", "translate"],
    pre: ["lang", "translate", "class", "style"],
    q: ["lang", "translate", "cite"],
    rp: ["lang", "translate"],
    rt: ["lang", "translate"],
    ruby: ["lang", "translate"],
    s: ["lang", "translate"],
    samp: ["lang", "translate"],
    section: ["lang", "translate", "class"],
    small: ["lang", "translate"],
    source: [
      "lang",
      "translate",
      "src",
      "srcset",
      "sizes",
      "media",
      "type",
      "width",
      "height",
    ],
    span: ["lang", "translate", "aria-hidden", "class", "style"],
    sub: ["lang", "translate"],
    summary: ["lang", "translate"],
    sup: ["class", "lang", "translate", "class"],
    strong: ["lang", "translate"],
    strike: ["lang", "translate"],
    table: ["lang", "translate", "width", "border", "align", "valign"],
    tbody: ["lang", "translate", "align", "valign"],
    td: ["lang", "translate", "width", "rowspan", "colspan", "align", "valign"],
    tfoot: ["lang", "translate", "align", "valign"],
    th: ["lang", "translate", "width", "rowspan", "colspan", "align", "valign"],
    thead: ["lang", "translate", "align", "valign"],
    time: ["lang", "translate", "datetime"],
    tr: ["lang", "translate", "rowspan", "align", "valign"],
    tt: ["lang", "translate"],
    u: ["lang", "translate"],
    ul: ["lang", "translate"],
    var: ["lang", "translate"],
    video: [
      "lang",
      "translate",
      "autoplay",
      "controls",
      "crossorigin",
      "loop",
      "muted",
      "playsinline",
      "poster",
      "preload",
      "src",
      "height",
      "width",
    ],

    // MathML
    math: ["class", "xmlns"],
    maction: ["actiontype", "selection"],
    annotation: ["encoding"],
    "annotation-xml": ["encoding"],
    menclose: ["notation"],
    merror: ["class"],
    mfenced: ["open", "close", "separators"],
    mfrac: ["linethickness"],
    mi: ["mathvariant"],
    mmultiscripts: ["subscriptshift", "superscriptshift"],
    mn: ["mathvariant"],
    mo: ["fence", "lspace", "rspace", "stretchy"],
    mover: ["accent"],
    mpadded: ["height", "depth", "width", "lspace", "voffset"],
    mphantom: ["class"],
    mprescripts: [],
    mroot: ["displaystyle"],
    mrow: ["displaystyle"],
    ms: ["lquote", "rquote"],
    semantics: ["class"],
    mspace: ["depth", "height", "width"],
    msqrt: ["displaystyle"],
    mstyle: ["displaystyle", "mathcolor", "mathbackground"],
    msub: ["subscriptshift"],
    msup: ["superscriptshift"],
    msubsup: ["subscriptshift", "superscriptshift"],
    mtable: [
      "align",
      "columnalign",
      "columnspacing",
      "columnlines",
      "rowalign",
      "rowspacing",
      "rowlines",
    ],
    mtd: ["columnalign", "rowalign"],
    mtext: ["mathvariant"],
    mtr: ["columnalign", "rowalign"],
    munder: ["accentunder"],
    munderover: ["accent", "accentunder"],
    eq: [],
    eqn: [],

    // SVG
    svg: ["class", "viewBox", "version", "width", "height", "aria-hidden"],
    path: [
      "d",
      "fill",
      "fill-opacity",
      "stroke",
      "stroke-width",
      "stroke-opacity",
      "stroke-dasharray",
    ],
    g: [
      "id",
      "class",
      "fill",
      "fill-opacity",
      "stroke",
      "stroke-width",
      "stroke-opacity",
      "stroke-dasharray",
      "transform",
    ],
    polygon: [
      "points",
      "fill",
      "fill-opacity",
      "stroke",
      "stroke-width",
      "stroke-opacity",
      "stroke-dasharray",
    ],
    polyline: [
      "points",
      "fill",
      "fill-opacity",
      "stroke",
      "stroke-width",
      "stroke-opacity",
      "stroke-dasharray",
    ],
    ellipse: [
      "cx",
      "cy",
      "rx",
      "ry",
      "fill",
      "fill-opacity",
      "stroke",
      "stroke-width",
      "stroke-opacity",
      "stroke-dasharray",
    ],
    linearGradient: ["id", "gradientUnits", "x1", "y1", "x2", "y2"],
    radialGradient: ["id", "gradientUnits", "cx", "cy", "r", "fx", "fy"],
    stop: ["offset", "stop-color", "stop-opacity", "style"],
    text: [
      "x",
      "y",
      "fill",
      "fill-opacity",
      "font-size",
      "font-family",
      "font-weight",
      "font-style",
      "text-anchor",
    ],
    defs: [],
    title: [],
  },
  css: {
    whiteList: {
      ...cssfilter.whiteList,
      color: true,
      "background-color": true,
      "font-style": true,
      "font-weight": true,
      "text-decoration": true,

      // Shiki
      "--shiki-dark": true,
      "--shiki-dark-bg": true,
      "--shiki-dark-font-style": true,
      "--shiki-dark-font-weight": true,
      "--shiki-dark-text-decoration": true,

      // SVG
      "stop-color": true,
      "stop-opacity": true,
    },
  },
});

const excerptHtmlXss = new FilterXSS({
  allowList: Object.fromEntries(
    Object.entries(whiteList).filter(([tag]) => tag !== "a"),
  ),
  stripIgnoreTag: true,
});

const textXss = new FilterXSS({
  allowList: {},
  stripIgnoreTag: true,
});

export function sanitizeHtml(html: string): string {
  return htmlXss.process(html);
}

export function sanitizeExcerptHtml(html: string): string {
  return excerptHtmlXss.process(html);
}

/**
 * Removes Hackers' Pub's legacy heading permalink controls from HTML that is
 * about to be federated.  Heading IDs are document structure and remain
 * intact; the empty `.header-anchor` link is a local UI affordance that the
 * browser now adds at runtime.
 *
 * This also covers rendered HTML persisted before the Markdown renderer
 * stopped emitting the links.
 */
export function removeHeaderAnchorLinks(html: string): string {
  const $ = load(html, null, false);
  $(
    "h1 > a.header-anchor, h2 > a.header-anchor, " +
      "h3 > a.header-anchor, h4 > a.header-anchor, " +
      "h5 > a.header-anchor, h6 > a.header-anchor",
  ).remove();
  return $.root().html() ?? "";
}

type DomNode = {
  type?: string;
  data?: string;
  children?: ReadonlyArray<unknown>;
};

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function toGraphemes(text: string): string[] {
  const out: string[] = [];
  for (const seg of graphemeSegmenter.segment(text)) out.push(seg.segment);
  return out;
}

function visibleGraphemeCount(nodes: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const node of nodes) {
    const n = node as DomNode;
    if (n.type === "text") {
      total += toGraphemes(n.data ?? "").length;
    } else if (n.children != null) {
      total += visibleGraphemeCount(n.children);
    }
  }
  return total;
}

/**
 * Truncates HTML to roughly `maxChars` visible grapheme clusters while keeping
 * the tag structure valid. Returns the input unchanged when the document's
 * total visible text already fits in the budget — otherwise the first text
 * node that crosses the budget is clipped, an ellipsis is appended, and every
 * node that follows (deeper or sibling) is removed. Containers around the
 * cutoff stay intact so the result is well-formed HTML that the browser can
 * hydrate without fixing up unclosed tags.
 *
 * Counting is done in grapheme clusters, not UTF-16 code units, so emoji and
 * combining sequences are not split mid-character. Whitespace inside text
 * nodes counts toward the budget — we don't collapse it because the caller's
 * CSS controls visual whitespace and we'd rather under- than over-truncate.
 * Comments, processing instructions, and non-text tag overhead don't count.
 */
export function truncateHtml(html: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const $ = load(html, null, false);
  const rootNodes = $.root().contents().toArray();

  // Pre-pass: if the whole document already fits in the budget, skip the
  // walk entirely. This also lets the truncation pass treat "this text node
  // exactly fills the budget" as a real cutoff (with ellipsis), because we
  // know there must be more content past it.
  if (visibleGraphemeCount(rootNodes) <= maxChars) return html;

  const ELLIPSIS = "…";
  let remaining = maxChars;
  let truncated = false;

  function walk(nodes: ReadonlyArray<unknown>): void {
    // Snapshot the list because we mutate during iteration (children removed
    // after the cutoff).
    for (const node of [...nodes]) {
      if (truncated) {
        $(node as never).remove();
        continue;
      }
      const n = node as DomNode;
      if (n.type === "text") {
        const graphemes = toGraphemes(n.data ?? "");
        if (graphemes.length < remaining) {
          remaining -= graphemes.length;
        } else {
          // `<` above (not `<=`) so a text node that *exactly* fills the
          // remaining budget still triggers truncation — there must be more
          // content past it (the pre-pass guaranteed total > maxChars), so an
          // ellipsis belongs here.
          const taken = graphemes.slice(0, remaining).join("");
          n.data = taken.replace(/\s+$/, "") + ELLIPSIS;
          remaining = 0;
          truncated = true;
        }
      } else if (n.children != null) {
        walk(n.children);
      }
      // Comments / other node kinds are kept as-is and don't count toward
      // the budget.
    }
  }

  walk(rootNodes);
  return $.html();
}

export function stripHtml(html: string): string {
  html = html.replaceAll(
    /\s*<(\/?br|\/?hr|\/?p|\/?h[1-6]|li)\b[^>]*>\s*/gi,
    (_, m) => `<${m}>`,
  );
  html = html.replaceAll(/([ \t\r\v]*\n[ \t\r\v]*)/g, "");
  html = html.replaceAll(
    /\s*<(\/?br|\/?hr|\/?p|\/?h[1-6]|\/?li)\s*\/?>\s*/gi,
    (_, m) =>
      m.endsWith("br") || m.endsWith("hr")
        ? "\n"
        : m === "li"
        ? ""
        : m === "/li"
        ? "\n"
        : "\n\n\n",
  );
  return unescape(textXss.process(html))
    .replaceAll(/(\r?\n){3,}/g, "\n\n")
    .trim();
}

export function transformMentions(
  html: string,
  mentions: readonly { actor: Actor }[] | null | undefined,
  tags: Record<string, string>,
): string {
  const mentionList = Array.isArray(mentions) ? mentions : [];
  const $ = load(html, null, false);
  $("a[href]:not(.hashtag)").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (href == null) return;
    const rel = $el.attr("rel")?.split(/\s+/g) ?? [];
    if (rel.includes("tag")) return;
    for (const { actor } of mentionList) {
      if (
        href === actor.iri || href === actor.url || actor.aliases.includes(href)
      ) {
        $el.addClass("mention");
        $el.attr(
          "title",
          `${actor.name ?? actor.username}\n${actor.handle}`,
        );
        $el.attr(
          "data-internal-href",
          actor.accountId == null ? `/${actor.handle}` : `/@${actor.username}`,
        );
        if (actor.avatarUrl != null) {
          $el.prepend(
            `<img src="${actor.avatarUrl}" width="18" height="18" class="inline-block mr-1">`,
          );
        }
        if (
          actor.name != null &&
          actor.name.toLowerCase().replace(/[\s_.-]+/g, "") !==
            actor.username.toLowerCase().replace(/[_.-]+/g, "")
        ) {
          $el.append(
            `<span class="name">${
              renderCustomEmojis(escape(actor.name), actor.emojis)
            }</span>`,
          );
        }
        break;
      }
    }
  });
  const invertedTags = invert(tags);
  $("a.mention.hashtag[href], a[rel=tag]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (href == null) return;
    let tag = invertedTags[href]?.replace(/^#/, "");
    if (tag == null) {
      tag = $el.text().replace(/^#/, "");
      if (href.toLowerCase() !== tags[tag.toLowerCase()]) return;
    }
    const localHref = `/tags/${encodeURIComponent(tag)}`;
    $el.attr("data-internal-href", localHref);
    $el.attr("href", localHref);
  });
  $("a[data-internal-href]").attr(
    "onclick",
    "location.href = this.dataset.internalHref; return false;",
  );
  return $.html();
}

/**
 * Work around <https://github.com/misskey-dev/misskey/issues/15698>.
 * @param html A content HTML.
 * @returns A transformed HTML.
 */
export function transformMisskeyInlineQuote(html: string): string {
  const $ = load(html, null, false);
  $("p:last-child > span:has(> br + br) + a[href]:last-child").each((_, el) => {
    const $a = $(el);
    if ($a.attr("href") !== $a.text()) return;
    const $span = $a.prev();
    if (!$span.text().trimEnd().endsWith("RE:")) return;
    const spanHtml = $span.html();
    if (spanHtml == null) return;
    $span.html(
      spanHtml.replace(
        /<br\s*\/?><br\s*\/?>RE:\s*$/,
        (m) => `<span class="quote-inline">${m}</span>`,
      ),
    );
    $a.addClass("quote-inline");
    console.debug($a.html());
  });
  return $.html();
}

/**
 * Removes FEP-044f quote-inline fallback text from post HTML.
 *
 * Platforms like Mastodon, Misskey, and Bluesky Bridge include a `RE: <url>`
 * fallback inside elements with `class="quote-inline"` for clients that don't
 * support native quote posts.  Call this only when the post has a resolved
 * `quotedPost`; for posts without one the fallback is the only reference.
 */
export function removeQuoteInlineFallback(html: string): string {
  const $ = load(html, null, false);

  // Track ancestor <p> elements of inline quote-inline elements so we can
  // clean them up if they become empty — without touching intentional spacer
  // paragraphs (<p><br></p>) elsewhere in the post.
  // deno-lint-ignore no-explicit-any
  const touchedParents = new Set<any>();

  // For inline elements (span, a), record the closest ancestor <p> and
  // remove preceding <br> siblings.  Some platforms (e.g. newer Misskey)
  // place <br><br> outside the span rather than inside it.
  $("span.quote-inline, a.quote-inline").each((_, el) => {
    const $closestP = $(el).closest("p");
    if ($closestP.length > 0) touchedParents.add($closestP.get(0));

    // deno-lint-ignore no-explicit-any
    let prev = (el as any).previousSibling;
    while (prev != null) {
      // deno-lint-ignore no-explicit-any
      const current = prev as any;
      // deno-lint-ignore no-explicit-any
      prev = (current as any).previousSibling;
      if (current.type === "text" && !current.data?.trim()) continue;
      if (current.type === "tag" && current.name === "br") {
        $(current).remove();
      } else {
        break;
      }
    }
  });

  $(".quote-inline").remove();

  // Clean up only the paragraphs that held quote-inline elements.  Limiting
  // the sweep to `touchedParents` avoids accidentally removing intentional
  // spacer paragraphs (<p><br></p>) that appear elsewhere in the post.
  for (const p of touchedParents) {
    const $p = $(p);
    if (!$p.text().trim() && !$p.children(":not(br)").length) {
      $p.remove();
    }
  }

  return $.html();
}

export interface PreprocessContentHtmlOptions {
  mentions: { actor: Actor }[];
  tags: Record<string, string>;
  emojis?: Record<string, string>;
  quote?: boolean;
  localDomain: URL;
}

export function preprocessContentHtml(
  html: string,
  { mentions, tags, emojis = {}, quote, localDomain }:
    PreprocessContentHtmlOptions,
) {
  html = sanitizeHtml(html);
  html = transformMentions(html, mentions, tags);
  html = renderCustomEmojis(html, emojis);
  if (quote) html = transformMisskeyInlineQuote(html);
  html = addExternalLinkTargets(html, localDomain);
  return html;
}

const HTML_HAS_ANCHOR = /<a\b/i;

interface ParseContentAnchorUrlOptions {
  excludedHrefs?: ReadonlySet<string>;
}

interface ContentAnchorElement {
  attr(name: string): string | undefined;
  hasClass(name: string): boolean;
}

function parseContentAnchorUrl(
  $el: ContentAnchorElement,
  options: ParseContentAnchorUrlOptions = {},
): URL | null {
  const href = $el.attr("href");
  if (href == null) return null;
  if (options.excludedHrefs?.has(href)) return null;
  if ($el.hasClass("mention") || $el.hasClass("hashtag")) return null;
  const rel = $el.attr("rel")?.split(/\s+/g) ?? [];
  if (rel.includes("tag")) return null;
  if (href.startsWith("#")) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return null;
  // Protocol-relative URLs (e.g. "//example.com/foo") need a base to parse.
  // Using https: preserves the host for same-origin comparison.
  const parseTarget = href.startsWith("//") ? `https:${href}` : href;
  const url = URL.parse(parseTarget);
  if (url == null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return null;
  }
  if (options.excludedHrefs?.has(url.href)) return null;
  return url;
}

export interface ExtractExternalLinksOptions {
  excludeHrefs?: Iterable<string>;
}

export function extractExternalLinks(
  html: string,
  options: ExtractExternalLinksOptions = {},
): URL[] {
  if (!HTML_HAS_ANCHOR.test(html)) return [];
  const $ = load(html, null, false);
  const excludedHrefs = options.excludeHrefs == null
    ? undefined
    : new Set(options.excludeHrefs);
  const links: URL[] = [];
  $("a[href]").each((_, el) => {
    const url = parseContentAnchorUrl($(el), { excludedHrefs });
    if (url != null) links.push(url);
  });
  return links;
}

/**
 * Marks external content links to open in a new tab. Same-origin links,
 * mentions, hashtags, and relative paths are left alone so in-app
 * navigation stays in the current tab.
 */
export function addExternalLinkTargets(
  html: string,
  localDomain?: URL,
): string {
  if (!HTML_HAS_ANCHOR.test(html)) return html;
  const localHost = localDomain?.host;
  const $ = load(html, null, false);
  $("a[href]").each((_, el) => {
    const $el = $(el);
    if ($el.attr("data-internal-href") != null) return;
    const url = parseContentAnchorUrl($el);
    if (url == null) return;
    if (localHost != null && url.host === localHost) return;
    const existingTarget = $el.attr("target");
    // Respect explicit non-blank targets (_self, _parent, _top, named
    // contexts). Those don't open a new browsing context, so rel hardening
    // is unnecessary.
    if (
      existingTarget != null &&
      existingTarget.trim().toLowerCase() !== "_blank"
    ) {
      return;
    }
    if (existingTarget == null) $el.attr("target", "_blank");
    // Merge noopener/noreferrer even when target="_blank" was pre-existing,
    // so sanitized remote HTML can't retain window.opener access.
    const relTokens = $el.attr("rel")?.split(/\s+/g).filter((t: string) =>
      t.length > 0
    ) ?? [];
    for (const token of ["noopener", "noreferrer"]) {
      if (!relTokens.includes(token)) relTokens.push(token);
    }
    $el.attr("rel", relTokens.join(" "));
  });
  return $.html();
}
