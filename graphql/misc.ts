import { expandGlob } from "@std/fs";
import { join } from "@std/path";
import { builder } from "./builder.ts";

const LOCALES_DIR = join(import.meta.dirname!, "locales");

builder.queryField("availableLocales", (t) =>
  t.field({
    type: ["Locale"],
    async resolve(_root, _args, _ctx) {
      const availableLocales: Intl.Locale[] = [];
      const files = expandGlob(join(LOCALES_DIR, "*.json"), {
        includeDirs: false,
      });
      for await (const file of files) {
        if (!file.isFile) continue;
        const match = file.name.match(/^(.+)\.json$/);
        if (match == null) continue;
        const localeName = match[1];
        availableLocales.push(new Intl.Locale(localeName));
      }
      return availableLocales;
    },
  }));
