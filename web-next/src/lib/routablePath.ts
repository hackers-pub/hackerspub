export function toRoutablePath(url: string): string {
  if (url.startsWith("/")) return url;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
