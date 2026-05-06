import type { Context, DocumentLoader } from "@fedify/fedify";
import { isActor } from "@fedify/vocab";
import type * as vocab from "@fedify/vocab";
import { hashtag, spanHashAndTag } from "@fedify/markdown-it-hashtag";
import { mention } from "@fedify/markdown-it-mention";
import texmath from "@hackerspub/markdown-it-texmath";
import { getLogger } from "@logtape/logtape";
import { titlePlugin as title } from "@mdit-vue/plugin-title";
import cjkBreaks from "@searking/markdown-it-cjk-breaks";
import { fromAsyncCodeToHtml } from "@shikijs/markdown-it/async";
import {
  transformerMetaHighlight,
  transformerMetaWordHighlight,
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
  transformerRemoveNotationEscape,
} from "@shikijs/transformers";
import { deadline } from "@std/async/deadline";
import { encodeAscii85 } from "@std/encoding/ascii85";
import { ASCII_DIACRITICS_REGEXP, slugify } from "@std/text/unstable-slugify";
import { load } from "cheerio";
import { arrayOverlaps, eq } from "drizzle-orm";
import katex from "katex";
import type Keyv from "keyv";
import abbr from "markdown-it-abbr";
import anchor from "markdown-it-anchor";
import MarkdownItAsync from "markdown-it-async";
import deflist from "markdown-it-deflist";
import footnote from "markdown-it-footnote";
import admonition from "markdown-it-github-alerts";
import graphviz from "markdown-it-graphviz";
import toc from "markdown-it-toc-done-right";
import { codeToHtml } from "shiki";
import { persistActor, persistActorsByHandles } from "./actor.ts";
import type { ContextData } from "./context.ts";
import { sanitizeExcerptHtml, sanitizeHtml, stripHtml } from "./html.ts";
import { negotiateLocale } from "./i18n.ts";
import { type Actor, actorTable } from "./schema.ts";

const logger = getLogger(["hackerspub", "models", "markup"]);

const KV_NAMESPACE = "markup";
const KV_CACHE_VERSION = "2025-06-08";

const MISSING_ARTICLE_MEDIUM_LABELS = {
  en: "This medium has not been attached to this article.",
  ja: "この記事に添付されていないメディアです。",
  ko: "이 게시글에 첨부된 적 없는 미디어입니다.",
  "zh-CN": "此媒体未附加到这篇文章。",
  "zh-TW": "此媒體未附加到這篇文章。",
} as const;

const DEFAULT_MISSING_ARTICLE_MEDIUM_LABEL = MISSING_ARTICLE_MEDIUM_LABELS.en;

let tocTree: InternalToc = { l: 0, n: "", c: [] };

const md = MarkdownItAsync({ html: true, linkify: true })
  .use(abbr)
  .use(admonition)
  .use(anchor, {
    slugifyWithState(title: string, state: { env: Env }) {
      return slugifyTitle(title, state.env.docId);
    },
    permalink: anchor.permalink.linkInsideHeader({
      symbol: `<span aria-hidden="true" title="Link to this section"></span>`,
      placement: "after",
    }),
  })
  .use(cjkBreaks)
  .use(deflist)
  .use(footnote)
  .use(graphviz)
  .use(hashtag, {
    link(tag: string, env: Env) {
      return new URL(
        `/tags/${encodeURIComponent(tag.replace(/^#/, ""))}`,
        env.origin,
      ).href;
    },
    linkAttributes() {
      return { class: "mention hashtag", rel: "tag" };
    },
    label: spanHashAndTag,
  })
  .use(mention, {
    localDomain(_bareHandle: string, env: Env) {
      return env.localDomain;
    },
    link(handle: string, env: Env) {
      const actor = env.mentionedActors[handle];
      if (actor == null) return null;
      return actor.url ?? actor.iri;
    },
    linkAttributes: (handle: string, env: Env) => {
      const actor = env.mentionedActors[handle];
      if (actor == null) return {};
      return {
        class: "u-url mention",
        title: actor.name ?? handle,
        "data-username": actor.username,
        "data-host": actor.instanceHost,
        "data-id": actor.id,
        "data-iri": actor.iri,
      };
    },
  })
  .use(texmath, {
    engine: katex,
    katexOptions: {
      output: "mathml",
      throwOnError: false,
    },
  })
  .use(title)
  .use(toc, {
    placeholder: `--${crypto.randomUUID()}--`.toUpperCase(),
    callback(_html: string, ast: InternalToc) {
      tocTree = ast;
    },
  })
  .use(
    fromAsyncCodeToHtml(
      async (code, options) => {
        try {
          return await codeToHtml(code, {
            ...options,
            lang: options.lang.toLowerCase(),
          });
        } catch {
          return await codeToHtml(code, { ...options, lang: "text" });
        }
      },
      {
        themes: {
          light: "vitesse-light",
          dark: "vitesse-dark",
        },
        defaultColor: "light-dark()",
        transformers: [
          transformerNotationDiff({ matchAlgorithm: "v3" }),
          transformerNotationHighlight({ matchAlgorithm: "v3" }),
          transformerMetaHighlight(),
          transformerNotationWordHighlight({ matchAlgorithm: "v3" }),
          transformerNotationErrorLevel({ matchAlgorithm: "v3" }),
          transformerMetaWordHighlight(),
          transformerNotationFocus({ matchAlgorithm: "v3" }),
          transformerRemoveNotationEscape(),
        ],
      },
    ),
  );

// This is a workaround for the fact that shiki turns into a strange state
// when the first invocation of codeToHtml is with a wrong lang name:
await codeToHtml("", { lang: "javascript", theme: "vitesse-light" });

export interface RenderedMarkup {
  html: string;
  excerptHtml: string;
  text: string;
  title: string;
  toc: Toc[];
  mentions: Record<string, Actor>;
  hashtags: string[];
}

interface Env {
  docId?: string | null;
  title: string;
  localDomain: string;
  origin: string;
  mentionedActors: Record<string, Actor>;
  hashtags: string[];
  macros: Record<string, unknown>;
}

export interface RenderMarkupOptions {
  kv?: Keyv | null;
  docId?: string | null;
  refresh?: boolean;
  mediumUrls?: Record<string, string>;
  missingMediumLabel?: string;
}

function canonicalizeMediumUrls(mediumUrls: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(mediumUrls).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    ),
  ));
}

export async function renderMarkup(
  fedCtx: Context<ContextData> | null | undefined,
  markup: string,
  options: RenderMarkupOptions = {},
): Promise<RenderedMarkup> {
  const mediumUrls = options.mediumUrls ?? {};
  const missingMediumLabel = options.missingMediumLabel ??
    DEFAULT_MISSING_ARTICLE_MEDIUM_LABEL;
  let cacheKey: string | undefined;
  if (options.kv != null) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${JSON.stringify(options.docId ?? null)}\n${
          canonicalizeMediumUrls(mediumUrls)
        }\n${JSON.stringify(missingMediumLabel)}\n${markup}`,
      ),
    );
    cacheKey = `${KV_NAMESPACE}/${KV_CACHE_VERSION}/markup/${
      encodeAscii85(digest)
    }`;
    if (!options.refresh) {
      const cached = await options.kv.get<RenderedMarkup>(cacheKey);
      if (cached != null) return cached;
    }
  }
  const localDomain = fedCtx == null
    ? "hackers.pub"
    : new URL(fedCtx.canonicalOrigin).host;
  const tmpMd = MarkdownItAsync().use(mention, {
    localDomain() {
      return localDomain;
    },
  });
  const tmpEnv: { mentions: string[] } = { mentions: [] };
  await tmpMd.renderAsync(markup, tmpEnv);
  const mentions = new Set(tmpEnv.mentions);
  logger.trace("Mentions: {mentions}", { mentions });
  const mentionedActors = fedCtx == null
    ? {}
    : await persistActorsByHandles(fedCtx, [...mentions]);
  logger.trace("Mentioned actors: {mentionedActors}", { mentionedActors });
  const env: Env = {
    docId: options.docId,
    title: "",
    localDomain,
    origin: fedCtx == null ? "https://hackers.pub" : fedCtx.canonicalOrigin,
    mentionedActors,
    hashtags: [],
    macros: {},
  };
  const rawHtml = (await md.renderAsync(markup, env))
    .replaceAll('<?xml version="1.0" encoding="UTF-8" standalone="no"?>', "")
    .replaceAll(
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"\n' +
        ' "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      "",
    );
  const resolvedHtml = resolveMediumUrlsInHtml(rawHtml, mediumUrls, {
    missingMediumLabel,
  });
  const html = sanitizeHtml(resolvedHtml);
  const excerptHtml = sanitizeExcerptHtml(resolvedHtml);
  const text = stripHtml(resolvedHtml);
  const toc = toToc(tocTree, options.docId);
  const rendered: RenderedMarkup = {
    html,
    excerptHtml,
    text,
    title: env.title,
    toc: toc.level < 1 ? toc.children : [toc],
    mentions: mentionedActors,
    hashtags: env.hashtags ?? [],
  };
  if (options.kv != null && cacheKey != null) {
    await options.kv.set(cacheKey, rendered);
  }
  return rendered;
}

export function getMissingArticleMediumLabel(
  locale?: Intl.Locale | string | null,
): string {
  if (locale == null) return DEFAULT_MISSING_ARTICLE_MEDIUM_LABEL;
  try {
    const matched = negotiateLocale(
      locale,
      Object.keys(MISSING_ARTICLE_MEDIUM_LABELS),
    )?.baseName as keyof typeof MISSING_ARTICLE_MEDIUM_LABELS | undefined;
    return matched == null
      ? DEFAULT_MISSING_ARTICLE_MEDIUM_LABEL
      : MISSING_ARTICLE_MEDIUM_LABELS[matched];
  } catch {
    return DEFAULT_MISSING_ARTICLE_MEDIUM_LABEL;
  }
}

export function resolveMediumUrls(
  markup: string,
  mediumUrls: Record<string, string>,
  options: { missingMediumLabel?: string } = {},
): string {
  const missingMediumUrl = createMissingMediumDataUrl(
    options.missingMediumLabel ?? DEFAULT_MISSING_ARTICLE_MEDIUM_LABEL,
  );
  return markup.replaceAll(
    /hp-medium:([A-Za-z0-9._:/-]+)/g,
    (_matched, key: string) => mediumUrls[key] ?? missingMediumUrl,
  );
}

function resolveMediumUrlsInHtml(
  html: string,
  mediumUrls: Record<string, string>,
  options: { missingMediumLabel: string },
): string {
  const missingMediumUrl = createMissingMediumDataUrl(
    options.missingMediumLabel,
  );
  const $ = load(html, null, false);
  // Medium currently only supports images. If audio or video uploads become
  // supported, extend this list to media-specific attributes such as
  // audio[src], video[src], and video[poster] with type-appropriate fallbacks.
  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (href == null) return;
    $el.attr("href", resolveMediumUrl(href, mediumUrls, missingMediumUrl));
  });
  $("img[src], source[src]").each((_, el) => {
    const $el = $(el);
    const src = $el.attr("src");
    if (src == null) return;
    $el.attr("src", resolveMediumUrl(src, mediumUrls, missingMediumUrl));
  });
  $("img[srcset], source[srcset]").each((_, el) => {
    const $el = $(el);
    const srcset = $el.attr("srcset");
    if (srcset == null) return;
    $el.attr(
      "srcset",
      resolveMediumSrcset(srcset, mediumUrls, missingMediumUrl),
    );
  });
  return $.root().html() ?? "";
}

function resolveMediumUrl(
  url: string,
  mediumUrls: Record<string, string>,
  missingMediumUrl: string,
): string {
  const matched = /^hp-medium:([A-Za-z0-9._:/-]+)$/.exec(url);
  if (matched == null) return url;
  return mediumUrls[matched[1]] ?? missingMediumUrl;
}

function resolveMediumSrcset(
  srcset: string,
  mediumUrls: Record<string, string>,
  missingMediumUrl: string,
): string {
  return srcset.split(",").map((candidate) => {
    const trimmed = candidate.trim();
    if (trimmed === "") return candidate;
    const matched = /^(\S+)(.*)$/.exec(trimmed);
    if (matched == null) return candidate;
    return `${resolveMediumUrl(matched[1], mediumUrls, missingMediumUrl)}${
      matched[2]
    }`;
  }).join(", ");
}

function createMissingMediumDataUrl(label: string): string {
  const text = escapeSvgText(label);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" role="img" aria-labelledby="title desc">
  <title id="title">${text}</title>
  <desc id="desc">${text}</desc>
  <rect width="1200" height="675" rx="16" fill="#fafafa"/>
  <rect x="1" y="1" width="1198" height="673" rx="15" fill="none" stroke="#d4d4d4" stroke-width="2"/>
  <g fill="none" stroke="#525252" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
    <rect x="455" y="190" width="290" height="210" rx="22"/>
    <circle cx="535" cy="265" r="28"/>
    <path d="M480 365l72-72 58 58 38-38 72 72"/>
    <path d="M430 440l340-340"/>
  </g>
  <text x="600" y="500" fill="#171717" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="36" font-weight="600" text-anchor="middle">${text}</text>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slugifyTitle(title: string, docId?: string | null): string {
  return (docId == null ? "" : docId + "--") +
    slugify(title, { strip: ASCII_DIACRITICS_REGEXP });
}

interface InternalToc {
  l: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  n: string;
  c: InternalToc[];
}

export interface Toc {
  id: string;
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  children: Toc[];
}

function toToc(toc: InternalToc, docId?: string | null): Toc {
  return {
    id: slugifyTitle(toc.n.trimStart(), docId),
    level: toc.l,
    title: toc.n.trimStart(),
    children: toc.c.map((t) => toToc(t, docId)),
  };
}

export interface ExtractMentionsFromHtmlOptions {
  contextLoader?: DocumentLoader;
  documentLoader?: DocumentLoader;
  kv?: Keyv;
}

export async function extractMentionsFromHtml(
  fedCtx: Context<ContextData>,
  html: string,
  options: ExtractMentionsFromHtmlOptions = {},
): Promise<{ actor: Actor }[]> {
  let cacheKey: string | undefined;
  if (options.kv != null) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(html),
    );
    cacheKey = `${KV_NAMESPACE}/${KV_CACHE_VERSION}/mentions/${
      encodeAscii85(digest)
    }`;
    const cached = await options.kv.get<Actor[]>(cacheKey);
    if (cached) return cached.map((actor) => ({ actor }));
  }
  const $ = load(html, null, false);
  const mentionHrefs = new Set<string>();
  $("a.mention[href]:not(.hashtag)").each((_, el) => {
    const href = $(el).attr("href");
    if (href != null) mentionHrefs.add(href);
  });
  if (mentionHrefs.size < 1) return [];
  const { db } = fedCtx.data;
  const actors = await db.query.actorTable.findMany({
    where: {
      OR: [
        { iri: { in: [...mentionHrefs] } },
        { url: { in: [...mentionHrefs] } },
        { RAW: (table) => arrayOverlaps(table.aliases, [...mentionHrefs]) },
      ],
    },
  });
  for (const actor of actors) {
    mentionHrefs.delete(actor.iri);
    if (actor.url != null) mentionHrefs.delete(actor.url);
    for (const alias of actor.aliases) mentionHrefs.delete(alias);
  }
  if (mentionHrefs.size < 1) return actors.map((actor) => ({ actor }));
  const mentionedUrls = [...mentionHrefs];
  logger.debug(
    "There are mentions to actors that are not persisted: {mentionedUrls}",
    { mentionedUrls },
  );
  const promises = mentionedUrls.map(async (href) => {
    try {
      return [
        href,
        await deadline(fedCtx.lookupObject(href, options), 3000),
      ] as [
        string,
        vocab.Object | null,
      ];
    } catch (_) {
      return null;
    }
  });
  for (const pair of await Promise.all(promises)) {
    if (pair == null) continue;
    const [href, object] = pair;
    if (!isActor(object)) continue;
    let actor = await persistActor(fedCtx, object, {
      ...options,
      outbox: false,
    });
    if (actor == null) continue;
    if (actor.iri !== href && !actor.aliases.includes(href)) {
      const aliases = [...actor.aliases, href];
      await db.update(actorTable)
        .set({ aliases })
        .where(eq(actorTable.id, actor.id));
      actor = { ...actor, aliases };
    }
    actors.push(actor);
  }
  if (options.kv != null && cacheKey != null) {
    await options.kv.set(cacheKey, actors);
  }
  return actors.map((actor) => ({ actor }));
}
