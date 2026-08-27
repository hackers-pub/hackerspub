interface ArticleViewReferrerOptions {
  readonly documentReferrer: string;
  readonly currentUrl: string;
  readonly initialDocumentUrl: string | null;
  readonly clientNavigationSeen: boolean;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function articlePageLocationChanged(
  firstUrl: string,
  secondUrl: string,
): boolean {
  const first = parseHttpUrl(firstUrl);
  const second = parseHttpUrl(secondUrl);
  if (first == null || second == null) return false;
  return (
    first.origin !== second.origin ||
    first.pathname !== second.pathname ||
    first.search !== second.search
  );
}

export function getArticleViewReferrerHostname(
  options: ArticleViewReferrerOptions,
): string | null {
  const current = parseHttpUrl(options.currentUrl);
  if (current == null) return null;
  if (
    options.clientNavigationSeen ||
    (options.initialDocumentUrl != null &&
      articlePageLocationChanged(options.initialDocumentUrl, current.href))
  ) {
    return current.hostname || null;
  }

  const referrer = parseHttpUrl(options.documentReferrer);
  return referrer?.hostname || null;
}
