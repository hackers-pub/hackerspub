import { expandGlob } from "@std/fs";
import { join } from "@std/path";
import { builder } from "./builder.ts";

const LOCALES_DIR = join(import.meta.dirname!, "locales");

let cachedLocales: Intl.Locale[] | null = null;

builder.queryField("suggestedFilterLanguages", (t) =>
  t.field({
    type: ["Locale"],
    description:
      "Base language codes to show in the timeline language filter. " +
      "When the viewer is authenticated and has language preferences set, " +
      "returns the base codes of those locales (e.g. `ko-KR` → `ko`). " +
      "Otherwise parses the `Accept-Language` request header and returns " +
      "its base codes in preference order. Returns an empty list when no " +
      "language information is available.",
    resolve(_root, _args, ctx) {
      if (ctx.account?.locales != null && ctx.account.locales.length > 0) {
        const seen = new Set<string>();
        const result: Intl.Locale[] = [];
        for (const loc of ctx.account.locales) {
          const base = new Intl.Locale(loc).language;
          if (base && !seen.has(base)) {
            seen.add(base);
            result.push(new Intl.Locale(base));
          }
        }
        return result;
      }
      const header = ctx.request.headers.get("accept-language") ?? "";
      if (!header) return [];
      // Parse each range: extract language tag and q-value, discard q=0.
      const parsed: { base: string; q: number }[] = [];
      for (const part of header.split(",")) {
        const [tagPart, ...params] = part.trim().split(";");
        const tag = tagPart.trim();
        let q = 1.0;
        for (const param of params) {
          const [k, v] = param.trim().split("=");
          if (k.trim().toLowerCase() === "q" && v != null) {
            q = parseFloat(v.trim());
            if (isNaN(q)) q = 1.0;
          }
        }
        if (q <= 0) continue;
        try {
          const base = new Intl.Locale(tag).language;
          if (base) parsed.push({ base, q });
        } catch {
          // ignore malformed tags
        }
      }
      // Sort descending by q to preserve preference order, then deduplicate.
      parsed.sort((a, b) => b.q - a.q);
      const seen = new Set<string>();
      const result: Intl.Locale[] = [];
      for (const { base } of parsed) {
        if (!seen.has(base)) {
          seen.add(base);
          result.push(new Intl.Locale(base));
        }
      }
      return result;
    },
  }));

builder.queryField("availableLocales", (t) =>
  t.field({
    type: ["Locale"],
    async resolve(_root, _args, _ctx) {
      if (cachedLocales) return cachedLocales;

      const availableLocales: Intl.Locale[] = [];
      const files = expandGlob(join(LOCALES_DIR, "*.json"), {
        includeDirs: false,
      });
      for await (const file of files) {
        if (!file.isFile) continue;
        const match = file.name.match(/^(.+)\.json$/);
        if (match == null) continue;
        const localeName = match[1];
        try {
          availableLocales.push(new Intl.Locale(localeName));
        } catch {
          // ignore invalid locale tags
        }
      }

      cachedLocales = availableLocales;
      return availableLocales;
    },
  }));
