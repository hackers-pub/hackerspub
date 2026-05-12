/**
 * Defensive encoder for the `[handle]` URL segment.
 *
 * Federation already constrains actor handles to a hostname-safe shape
 * (`@user@instance.tld`), so legitimate handles never contain path
 * delimiters.  We still escape:
 *
 *  - `/` and `\` — browsers normalise backslashes to forward slashes
 *    in URL parsing, so either would close the path segment.
 *  - `?` and `#` — start the query string and fragment.
 *  - `%` — a literal percent could otherwise be misread as the prefix
 *    of a percent-encoded delimiter when the router decodes the param.
 *
 * Use this helper anywhere a stored handle is spliced into a route URL.
 */
export function encodeHandleSegment(handle: string): string {
  return handle.replace(/[%/?#\\]/g, encodeURIComponent);
}
