export interface ArticleOgImageContent {
  readonly language: string;
  readonly url?: string | null;
}

export function articleOgImageUrl(
  articleUrl: string | null | undefined,
  currentContent: ArticleOgImageContent | null | undefined,
  articleLanguage: string | null | undefined,
): string | null {
  const currentContentUrl = currentContent?.url;
  const baseUrl = articleUrl ?? currentContentUrl;
  if (baseUrl == null || currentContent == null) return null;

  const url = new URL(baseUrl);
  if (
    articleUrl == null &&
    articleLanguage != null &&
    currentContent.language !== articleLanguage
  ) {
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ogimage`;
  if (articleLanguage == null || currentContent.language !== articleLanguage) {
    url.searchParams.set("l", currentContent.language);
  }
  return url.toString();
}
