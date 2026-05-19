import { useLocation, useSearchParams } from "@solidjs/router";
import { normalizeLanguageParam } from "./languageParam.ts";

/**
 * Encapsulates the `?language=` search param handling shared by all timeline
 * routes. Call once at component setup time; `initialLang` is captured
 * non-reactively so the initial preloaded query reference stays stable across
 * filter-pill clicks (subsequent changes are handled by fragment-level refetch
 * inside the timeline component).
 */
export function useLanguageFilter(basePath: string) {
  const location = useLocation();
  const [searchParams] = useSearchParams<{ language?: string }>();

  const initialLang = normalizeLanguageParam(searchParams.language);
  const activeLanguage = () => normalizeLanguageParam(searchParams.language);

  const buildHref = (lang: string | undefined) => {
    const p = new URLSearchParams(location.search);
    if (lang) p.set("language", lang);
    else p.delete("language");
    const qs = p.toString();
    return basePath + (qs ? "?" + qs : "");
  };

  return { activeLanguage, initialLang, buildHref };
}
