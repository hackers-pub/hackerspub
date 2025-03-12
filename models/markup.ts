import type { Context } from "@fedify/fedify";
import { mention } from "@fedify/markdown-it-mention";
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
import { DIACRITICS, slugify } from "@std/text/unstable-slugify";
import katex from "katex";
import createMarkdownIt from "markdown-it";
import abbr from "markdown-it-abbr";
import anchor from "markdown-it-anchor";
import deflist from "markdown-it-deflist";
import footnote from "markdown-it-footnote";
import admonition from "markdown-it-github-alerts";
import graphviz from "markdown-it-graphviz";
import texmath from "markdown-it-texmath";
import toc from "markdown-it-toc-done-right";
import type { Database } from "../db.ts";
import { persistActorsByHandles } from "./actor.ts";
import type { Actor } from "./schema.ts";
import { sanitizeExcerptHtml, sanitizeHtml, stripHtml } from "./xss.ts";

let tocTree: InternalToc = { l: 0, n: "", c: [] };

let md = createMarkdownIt({ html: true, linkify: true })
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
  .use(texmath, { engine: katex })
  .use(title)
  .use(toc, {
    placeholder: `--${crypto.randomUUID()}--`.toUpperCase(),
    callback(_html: string, ast: InternalToc) {
      tocTree = ast;
    },
  });

// Lazy load Shiki to avoid blocking the startup time
let shikiLoaded = false;
let loadingShiki = new Promise<void>((resolve) =>
  setTimeout(() => {
    loadingShiki = shiki({
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
      resolve();
    });
  }, 500)
);

export interface RenderedMarkup {
  html: string;
  excerptHtml: string;
  text: string;
  title: string;
  toc: Toc[];
  mentions: Record<string, Actor>;
}

interface Env {
  docId: string | null;
  title: string;
  localDomain: string;
  mentionedActors: Record<string, Actor>;
}

export async function renderMarkup(
  db: Database,
  fedCtx: Context<void>,
  docId: string | null,
  markup: string,
): Promise<RenderedMarkup> {
  const localDomain = new URL(fedCtx.canonicalOrigin).host;
  const tmpMd = createMarkdownIt().use(mention, {
    localDomain() {
      return localDomain;
    },
  });
  const tmpEnv: { mentions: string[] } = { mentions: [] };
  tmpMd.render(markup, tmpEnv);
  const mentions = new Set(tmpEnv.mentions);
  const mentionedActors = await persistActorsByHandles(db, fedCtx, [
    ...mentions,
  ]);
  if (!shikiLoaded) await loadingShiki;
  const env: Env = { docId, title: "", localDomain, mentionedActors };
  const rawHtml = md.render(markup, env)
    .replaceAll('<?xml version="1.0" encoding="UTF-8" standalone="no"?>', "")
    .replaceAll(
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"\n' +
        ' "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      "",
    );
  const html = sanitizeHtml(rawHtml);
  const excerptHtml = sanitizeExcerptHtml(rawHtml);
  const text = stripHtml(rawHtml);
  const toc = toToc(tocTree);
  const rendered: RenderedMarkup = {
    html,
    excerptHtml,
    text,
    title: env.title,
    toc: toc.level < 1 ? toc.children : [toc],
    mentions: mentionedActors,
  };
  return rendered;
}

function slugifyTitle(title: string, docId: string | null): string {
  return (docId == null ? "" : docId + "--") +
    slugify(title, { strip: DIACRITICS });
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
