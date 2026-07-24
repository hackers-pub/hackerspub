import { negotiateLocale } from "@hackerspub/models/i18n";
import { renderMarkup, type Toc } from "@hackerspub/models/markup";
import { dirname, join } from "@std/path";
import { readdir, readFile } from "node:fs/promises";
import { builder } from "./builder.ts";

const readTextFile = (path: string | URL) => readFile(path, "utf8");

interface Document {
  locale: Intl.Locale;
  markdown: string;
  html: string;
  title: string;
  toc: Toc[];
}

const DocumentRef = builder.objectRef<Document>("Document");

DocumentRef.implement({
  description: "A document in a specific language.",
  fields: (t) => ({
    locale: t.expose("locale", {
      type: "Locale",
      description: "The locale of the document.",
    }),
    title: t.exposeString("title", {
      description: "The title of the document.",
    }),
    markdown: t.exposeString("markdown"),
    html: t.exposeString("html"),
    toc: t.expose("toc", {
      type: "JSON",
      description: "Table of contents for the document.",
    }),
  }),
});

const COC_DIR = dirname(import.meta.dirname!);
const MARKDOWN_GUIDE_DIR = join(import.meta.dirname!, "locales", "markdown");
const SEARCH_GUIDE_DIR = join(import.meta.dirname!, "locales", "search");
const PRIVACY_POLICY_DIR = COC_DIR;

builder.queryFields((t) => ({
  codeOfConduct: t.field({
    type: DocumentRef,
    args: {
      locale: t.arg({
        type: "Locale",
        required: true,
        description: "The locale for the Code of Conduct.",
      }),
    },
    async resolve(_, args, ctx) {
      const availableLocales: Record<string, string> = {};
      const files = await readdir(COC_DIR, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        const match = file.name.match(/^CODE_OF_CONDUCT\.(.+)\.md$/);
        if (match == null) continue;
        const locale = match[1];
        availableLocales[locale] = join(COC_DIR, file.name);
      }
      const locale =
        negotiateLocale(args.locale, Object.keys(availableLocales)) ??
        new Intl.Locale("en");
      const path = availableLocales[locale.baseName];
      const markdown = await readTextFile(path);
      const rendered = await renderMarkup(ctx.fedCtx, markdown, {
        kv: ctx.kv,
      });
      return {
        locale: locale,
        markdown,
        html: rendered.html,
        title: rendered.title,
        toc: rendered.toc,
      };
    },
  }),
  markdownGuide: t.field({
    type: DocumentRef,
    args: {
      locale: t.arg({
        type: "Locale",
        required: true,
        description: "The locale for the Markdown guide.",
      }),
    },
    async resolve(_, args, ctx) {
      const availableLocales: Record<string, string> = {};
      const files = await readdir(MARKDOWN_GUIDE_DIR, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        const match = file.name.match(/^(.+)\.md$/);
        if (match == null) continue;
        const locale = match[1];
        availableLocales[locale] = join(MARKDOWN_GUIDE_DIR, file.name);
      }
      const locale =
        negotiateLocale(args.locale, Object.keys(availableLocales)) ??
        new Intl.Locale("en");
      const path = availableLocales[locale.baseName];
      const markdown = await readTextFile(path);
      const rendered = await renderMarkup(ctx.fedCtx, markdown, {
        kv: ctx.kv,
      });
      return {
        locale: locale,
        markdown,
        html: rendered.html,
        title: rendered.title,
        toc: rendered.toc,
      };
    },
  }),
  searchGuide: t.field({
    type: DocumentRef,
    args: {
      locale: t.arg({
        type: "Locale",
        required: true,
        description: "The locale for the search guide.",
      }),
    },
    async resolve(_, args, ctx) {
      const availableLocales: Record<string, string> = {};
      const files = await readdir(SEARCH_GUIDE_DIR, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        const match = file.name.match(/^(.+)\.md$/);
        if (match == null) continue;
        const locale = match[1];
        availableLocales[locale] = join(SEARCH_GUIDE_DIR, file.name);
      }
      const locale =
        negotiateLocale(args.locale, Object.keys(availableLocales)) ??
        new Intl.Locale("en");
      const path = availableLocales[locale.baseName];
      const markdown = await readTextFile(path);
      const rendered = await renderMarkup(ctx.fedCtx, markdown, {
        kv: ctx.kv,
      });
      return {
        locale: locale,
        markdown,
        html: rendered.html,
        title: rendered.title,
        toc: rendered.toc,
      };
    },
  }),
  privacyPolicy: t.field({
    type: DocumentRef,
    args: {
      locale: t.arg({
        type: "Locale",
        required: true,
        description: "The locale for the Privacy Policy.",
      }),
    },
    async resolve(_, args, ctx) {
      const availableLocales: Record<string, string> = {};
      const files = await readdir(PRIVACY_POLICY_DIR, {
        withFileTypes: true,
      });
      for (const file of files) {
        if (!file.isFile()) continue;
        const match = file.name.match(/^PRIVACY_POLICY\.(.+)\.md$/);
        if (match == null) continue;
        const locale = match[1];
        availableLocales[locale] = join(PRIVACY_POLICY_DIR, file.name);
      }
      const locale =
        negotiateLocale(args.locale, Object.keys(availableLocales)) ??
        new Intl.Locale("en");
      const path = availableLocales[locale.baseName];
      const markdown = await readTextFile(path);
      const rendered = await renderMarkup(ctx.fedCtx, markdown, {
        kv: ctx.kv,
      });
      return {
        locale: locale,
        markdown,
        html: rendered.html,
        title: rendered.title,
        toc: rendered.toc,
      };
    },
  }),
}));
