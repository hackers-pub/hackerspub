export function getValidLocaleBaseName(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).baseName;
  } catch {
    return undefined;
  }
}

export function getValidLocaleBaseNames(locales: readonly string[]): string[] {
  const result: string[] = [];
  for (const locale of locales) {
    const baseName = getValidLocaleBaseName(locale);
    if (baseName != null) result.push(baseName);
  }
  return result;
}
