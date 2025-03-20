import { escape, unescape } from "@std/html/entities";
import { load } from "cheerio";
import * as cssfilter from "cssfilter";
import { FilterXSS, whiteList } from "xss";
import { renderCustomEmojis } from "./emoji.ts";
import type { Actor } from "./schema.ts";

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
    ol: ["class", "lang", "translate"],
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

export function stripHtml(html: string): string {
  return unescape(
    textXss.process(
      html
        .replace(/\s*<(\/?br|\/?p|\/?h[1-6])\b[^>]*>\s*/g, (m) => `<${m[1]}>`)
        .replace(/([ \t\r\v]*\n[ \t\r\v]*)/g, "")
        .replace(
          /\s*<(\/?br|\/?p|\/?h[1-6])\s*\/?>\s*/g,
          (m) => m[1].endsWith("br") ? "\n" : "\n\n\n",
        ),
    ),
  ).replace(/(\r?\n){3,}/, "\n\n").trim();
}

export function transformMentions(
  html: string,
  mentions: { actor: Actor }[],
): string {
  const $ = load(html, null, false);
  $("a.mention[href]:not(.hashtag)").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (href == null) return;
    for (const { actor } of mentions) {
      if (
        href === actor.iri || href === actor.url || actor.aliases.includes(href)
      ) {
        $el.attr(
          "title",
          `${
            actor.name ?? actor.username
          }\n@${actor.username}@${actor.instanceHost}`,
        );
        $el.attr(
          "data-internal-href",
          actor.accountId == null
            ? `/@${actor.username}@${actor.instanceHost}`
            : `/@${actor.username}`,
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
  $("a.mention[data-internal-href]").attr(
    "onclick",
    "location.href = this.dataset.internalHref; return false;",
  );
  return $.html();
}

export function preprocessContentHtml(
  html: string,
  mentions: { actor: Actor }[],
  emojis: Record<string, string>,
) {
  html = sanitizeHtml(html);
  html = transformMentions(html, mentions);
  html = renderCustomEmojis(html, emojis);
  return html;
}

export function extractExternalLinks(html: string): URL[] {
  // Extract external links from an HTML fragmenmt, except for mentions
  // and hashtags.  This is used to extract links from the content of a post.
  const $ = load(html, null, false);
  const links: URL[] = [];
  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (href == null) return;
    if ($el.hasClass("mention") || $el.hasClass("hashtag")) return;
    const rel = $el.attr("rel")?.split(/\s+/g) ?? [];
    if (rel.includes("tag")) return;
    if (href.startsWith("/")) return;
    if (href.startsWith("#")) return;
    const url = URL.parse(href);
    if (url == null || url.protocol !== "http:" && url.protocol !== "https:") {
      return;
    }
    links.push(url);
  });
  return links;
}
