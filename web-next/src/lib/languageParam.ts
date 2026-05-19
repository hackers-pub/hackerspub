/**
 * Normalizes a raw `?language=` search parameter value to a BCP 47 base
 * language code (e.g. `"en-US"` → `"en"`), or `undefined` if the value is
 * absent or invalid.
 */
export function normalizeLanguageParam(
  raw: string | string[] | undefined,
): string | undefined {
  const tag = Array.isArray(raw) ? raw[0] : raw;
  if (!tag) return undefined;
  try {
    return new Intl.Locale(tag).language;
  } catch {
    return undefined;
  }
}
