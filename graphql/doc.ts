import type { Locale } from "@hackerspub/models/i18n";
import { renderMarkup, type Toc } from "@hackerspub/models/markup";
import { exists, expandGlob } from "@std/fs";
import { basename, dirname, join } from "@std/path";
import { builder } from "./builder.ts";

interface Document {
  locale: Locale;
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
    markdown: t.exposeString("markdown"),
    html: t.exposeString("html"),
    toc: t.expose("toc", {
      type: "JSON",
      description: "Table of contents for the document.",
    }),
  }),
});

const COC_DIR = dirname(import.meta.dirname!);
const COC_PATH = (locale: string) =>
  join(COC_DIR, `CODE_OF_CONDUCT.${locale}.md`);

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
      // TODO: Deal with RFC 5646 language tags with a proper parser like
      //       @phensley/language-tag
      const match = args.locale.match(/^([a-z]{2,3})(?:-([a-z]{2}))?$/i);
      const locale = match == null
        ? "en"
        : `${match[1].toLowerCase()}${
          match[2] ? `-${match[2].toUpperCase()}` : ""
        }`;
      let path = COC_PATH(locale);
      if (!await exists(path, { isFile: true })) {
        const lang = locale.replace(/[-_].*$/, "").toLowerCase();
        path = COC_PATH(lang);
        if (lang === locale || !await exists(path, { isFile: true })) {
          path = COC_PATH("en");
          const files = expandGlob(COC_PATH("*"), { includeDirs: false });
          for await (const file of files) {
            if (!file.isFile) continue;
            if (!file.name.startsWith(`CODE_OF_CONDUCT.${lang}`)) continue;
            path = file.path;
            break;
          }
        }
      }
      const match2 = basename(path).match(/^CODE_OF_CONDUCT\.(.+)\.md$/);
      const markdown = await Deno.readTextFile(path);
      const rendered = await renderMarkup(ctx.fedCtx, markdown);
      return {
        locale: (match2 ? match2[1] : "en") as Locale,
        markdown,
        html: rendered.html,
        title: rendered.title,
        toc: rendered.toc,
      };
    },
  }),
}));
