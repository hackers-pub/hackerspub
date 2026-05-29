/**
 * Decode a route parameter captured by SolidStart's `useParams()`.
 *
 * SolidStart does not URL-decode path segments, so non-ASCII params (e.g.
 * Korean actor handles or article slugs) arrive percent-encoded and must be
 * decoded before they are used as GraphQL variables or compared against
 * decoded server values.
 *
 * Malformed percent-encoding (a bare `%`, a truncated `%E0%A4`, etc.) makes
 * `decodeURIComponent` throw a `URIError`.  We swallow that and fall back to
 * the raw value so a hand-crafted bad URL degrades to an ordinary "not found"
 * lookup instead of an uncaught 500.
 */
export function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
