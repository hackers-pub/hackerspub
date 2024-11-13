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

const md = createMarkdownIt({ html: true })
  .use(abbr)
  .use(admonition)
  .use(anchor, {
    slugifyWithState(title: string, state: { env: { docId: string } }) {
      return slugifyTitle(title, state.env.docId);
    },
    permalink: anchor.permalink.linkInsideHeader({
      symbol: `<span aria-hidden="true">#</span>`,
      placement: "before",
    }),
  })
  .use(cjkBreaks)
  .use(deflist)
  .use(footnote)
  .use(
    await shiki({
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
    }),
  )
  .use(title)
  .use(toc, {
    placeholder: `--${crypto.randomUUID()}--`.toUpperCase(),
    callback(_html: string, ast: InternalToc) {
      tocTree = ast;
    },
  });

const textEncoder = new TextEncoder();

const xss = new FilterXSS({
  allowList: {
    a: ["lang", "target", "href", "hreflang", "title", "rel", "class"],
    abbr: ["lang", "title"],
    address: ["lang"],
    area: ["lang", "shape", "coords", "href", "alt"],
    article: ["lang"],
    aside: ["lang"],
    audio: [
      "lang",
      "autoplay",
      "controls",
      "crossorigin",
      "loop",
      "muted",
      "preload",
      "src",
    ],
    b: ["lang"],
    bdi: ["lang", "dir"],
    bdo: ["lang", "dir"],
    big: ["lang"],
    blockquote: ["lang", "cite"],
    br: ["lang"],
    caption: ["lang"],
    center: ["lang"],
    cite: ["lang"],
    code: ["lang"],
    col: ["lang", "align", "valign", "span", "width"],
    colgroup: ["lang", "align", "valign", "span", "width"],
    dd: ["lang"],
    del: ["lang", "datetime"],
    details: ["lang", "open"],
    dfn: ["lang"],
    div: ["lang"],
    dl: ["lang"],
    dt: ["lang"],
    em: ["lang"],
    figcaption: ["lang"],
    figure: ["lang"],
    font: ["lang", "color", "size", "face"],
    footer: ["lang"],
    h1: ["lang", "id"],
    h2: ["lang", "id"],
    h3: ["lang", "id"],
    h4: ["lang", "id"],
    h5: ["lang", "id"],
    h6: ["lang", "id"],
    header: ["lang"],
    hr: ["class"],
    i: ["lang"],
    img: ["lang", "src", "alt", "title", "width", "height", "loading"],
    ins: ["lang", "datetime"],
    kbd: ["lang"],
    li: ["lang"],
    mark: ["lang"],
    nav: ["lang"],
    ol: ["lang"],
    p: ["lang"],
    picture: ["lang"],
    pre: ["lang", "class", "style"],
    q: ["lang", "cite"],
    rp: ["lang"],
    rt: ["lang"],
    ruby: ["lang"],
    s: ["lang"],
    samp: ["lang"],
    section: ["lang", "class"],
    small: ["lang"],
    source: [
      "lang",
      "src",
      "srcset",
      "sizes",
      "media",
      "type",
      "width",
      "height",
    ],
    span: ["lang", "aria-hidden", "class", "style"],
    sub: ["lang"],
    summary: ["lang"],
    sup: ["lang", "class"],
    strong: ["lang"],
    strike: ["lang"],
    table: ["lang", "width", "border", "align", "valign"],
    tbody: ["lang", "align", "valign"],
    td: ["lang", "width", "rowspan", "colspan", "align", "valign"],
    tfoot: ["lang", "align", "valign"],
    th: ["lang", "width", "rowspan", "colspan", "align", "valign"],
    thead: ["lang", "align", "valign"],
    time: ["lang", "datetime"],
    tr: ["lang", "rowspan", "align", "valign"],
    tt: ["lang"],
    u: ["lang"],
    ul: ["lang"],
    var: ["lang"],
    video: [
      "lang",
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
  css: false,
});

const textXss = new FilterXSS({
  allowList: {},
  stripIgnoreTag: true,
});

const KV_NAMESPACE = ["markup", "v4"];

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
