export function compactUrl(url: string | URL): string {
  url = new URL(url);
  return url.protocol !== "https:" && url.protocol !== "http:"
    ? url.href
    : url.host +
      (url.searchParams.size < 1 && (url.hash === "" || url.hash === "#")
        ? url.pathname.replace(/\/+$/, "")
        : url.pathname) +
      (url.searchParams.size < 1 ? "" : url.search) +
      (url.hash === "#" ? "" : url.hash);
}

export function getAccountLinkDisplayText(
  url: string | URL,
  handle?: string | null,
): string {
  const parsed = new URL(url);
  const host = parsed.host.replace(/^www\./, "");
  if (host === "github.com") {
    const segments = parsed.pathname.split("/").filter((segment) =>
      segment !== ""
    );
    if (segments.length === 1) return `@${segments[0]}`;
    if (segments.length === 2) return `${segments[0]}/${segments[1]}`;

    // Older rows may have stored the repository owner's handle for any GitHub
    // URL.  Prefer the full URL for paths that identify something more specific.
    return compactUrl(parsed);
  }
  return handle ?? compactUrl(parsed);
}
