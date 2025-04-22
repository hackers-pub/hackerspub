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
