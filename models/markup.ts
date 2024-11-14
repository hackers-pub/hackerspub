import { getLogger } from "@logtape/logtape";
import { titlePlugin as title } from "@mdit-vue/plugin-title";
import cjkBreaks from "@searking/markdown-it-cjk-breaks";
import shiki from "@shikijs/markdown-it";
import {
  transformerMetaHighlight,
  transformerMetaWordHighlight,
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { NON_ASCII, slugify } from "@std/text/unstable-slugify";
import transliterate from "any-ascii";
import * as cssfilter from "cssfilter";
import createMarkdownIt from "markdown-it";
import abbr from "markdown-it-abbr";
import { alertPlugin as admonition } from "markdown-it-github-alert";
import anchor from "markdown-it-anchor";
import deflist from "markdown-it-deflist";
import footnote from "markdown-it-footnote";
import toc from "markdown-it-toc-done-right";
import { FilterXSS } from "xss";

const logger = getLogger(["hackerspub", "models", "markup"]);

let tocTree: InternalToc = { l: 0, n: "", c: [] };

let md = createMarkdownIt({ html: true })
  .use(abbr)
  .use(admonition)
  .use(anchor, {
    slugifyWithState(title: string, state: { env: { docId: string } }) {
      return slugifyTitle(title, state.env.docId);
    },
    permalink: anchor.permalink.linkInsideHeader({
      symbol: `<span aria-hidden="true" title="Link to this section">#</span>`,
      placement: "after",
    }),
  })
  .use(cjkBreaks)
  .use(deflist)
  .use(footnote)
  .use(title)
  .use(toc, {
    placeholder: `--${crypto.randomUUID()}--`.toUpperCase(),
    callback(_html: string, ast: InternalToc) {
      tocTree = ast;
    },
  });

// Lazy load Shiki to avoid blocking the startup time
let shikiLoaded = false;
const loadingShiki = shiki({
  themes: {
    light: "vitesse-light",
    dark: "vitesse-dark",
  },
  transformers: [
    transformerNotationDiff(),
    transformerNotationHighlight(),
    transformerMetaHighlight(),
    transformerNotationWordHighlight(),
    transformerMetaWordHighlight(),
    transformerNotationFocus(),
  ],
}).then((shiki) => {
  md = md.use(shiki);
  shikiLoaded = true;
});

const textEncoder = new TextEncoder();

export const xss = new FilterXSS({
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
    div: ["lang", "translate"],
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
    li: ["lang", "translate"],
    mark: ["lang", "translate"],
    nav: ["lang", "translate"],
    ol: ["lang", "translate"],
    p: ["lang", "translate"],
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
    sup: ["lang", "translate", "class"],
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
  },
  css: {
    whiteList: {
      ...cssfilter.whiteList,
      color: true,
      "background-color": true,
      "font-style": true,
      "font-weight": true,
      "text-decoration": true,
      "--shiki-dark": true,
      "--shiki-dark-bg": true,
      "--shiki-dark-font-style": true,
      "--shiki-dark-font-weight": true,
      "--shiki-dark-text-decoration": true,
    },
  },
});

const textXss = new FilterXSS({
  allowList: {},
  stripIgnoreTag: true,
});

const KV_NAMESPACE = ["markup", "v5"];

export interface RenderedMarkup {
  html: string;
  text: string;
  title: string;
  toc: Toc[];
}

export async function renderMarkup(
  kv: Deno.Kv,
  docId: string,
  markup: string,
): Promise<RenderedMarkup> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(markup)),
  );
  const key = [...KV_NAMESPACE, hash];
  const result = await kv.get<RenderedMarkup>(key);
  if (result.value != null) return result.value;
  if (!shikiLoaded) await loadingShiki;
  const env = { docId, title: "" };
  const rawHtml = md.render(markup, env);
  logger.debug(
    "Processed Markdown for {docId}:\n{rawHtml}",
    { docId, rawHtml },
  );
  const html = xss.process(rawHtml);
  const text = textXss.process(rawHtml);
  const toc = toToc(tocTree);
  const rendered: RenderedMarkup = {
    html,
    text,
    title: env.title,
    toc: toc.level < 1 ? toc.children : [toc],
  };
  await kv.set(key, rendered, { expireIn: 30 * 24 * 60 * 60 * 1000 });
  return rendered;
}

function slugifyTitle(title: string, docId: string): string {
  return docId + "--" + slugify(title, { transliterate, strip: NON_ASCII });
}

interface InternalToc {
  l: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  n: string;
  c: InternalToc[];
}

export interface Toc {
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  children: Toc[];
}

function toToc(toc: InternalToc): Toc {
  return {
    level: toc.l,
    title: toc.n.trimStart(),
    children: toc.c.map(toToc),
  };
}
