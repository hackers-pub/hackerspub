/**
 * Cloudflare Worker that serves web-next's content-hashed client assets
 * (`/_build/assets/*`) for hackers.pub directly from a Cloudflare R2 bucket.
 *
 * Why this exists
 * ---------------
 * The production app ships as a single container image whose
 * `web-next/.output/public/_build/assets/` directory holds only the *current*
 * build's chunks. Each deploy replaces the image, so the previous build's
 * chunks vanish from the origin. A browser tab that loaded the old build and
 * then lazily imports a route chunk (e.g. `(root)-<hash>.js`) afterwards would
 * 404, surfacing as `TypeError: error loading dynamically imported module`
 * (Sentry WEB-NEXT-C).
 *
 * CI mirrors every build's assets into R2 (see `.github/workflows/main.yml`,
 * job `upload-assets`) without ever deleting old objects. Because the
 * filenames are content-hashed they never collide, so R2 accumulates every
 * deploy's chunks. This Worker, bound to that bucket and routed at
 * `hackers.pub/_build/assets/*`, serves them, so already-loaded tabs keep
 * working across deploys.
 *
 * Keeping the assets on the *same origin* (rather than a separate CDN
 * hostname) is deliberate: SolidStart/Nitro resolves dynamic `import()`
 * specifiers relative to the importing chunk's URL, and Vite's `base` doubles
 * as the server router mount path (an absolute CDN base corrupts routing).
 * Same-origin serving sidesteps both problems and needs no CORS.
 *
 * On an R2 miss the Worker falls back to the origin, which also makes deploys
 * race-free: if a brand-new build's HTML reaches a browser before CI finishes
 * uploading that build's chunks, the origin (which has the current build)
 * serves them.
 */

interface Env {
  /** R2 bucket binding holding `_build/assets/*` objects. */
  ASSETS: R2Bucket;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Only GET/HEAD are cacheable static-asset reads; defer anything else to
    // the origin.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fetch(request);
    }
    // Note: we intentionally do NOT special-case `Range` requests. Serving the
    // full object with `200` is a valid response to a range request (the client
    // takes what it needs), and these are small, immutable JS/CSS/font chunks
    // for which ranged reads are vanishingly rare. Falling back to the origin
    // on `Range` instead would reintroduce the exact bug this Worker fixes: an
    // old hashed asset that no longer exists on the origin would 404 even
    // though R2 still has it. Cloudflare's edge cache can still satisfy a
    // subsequent ranged request from the cached full response.

    const url = new URL(request.url);
    // Object key mirrors the request path without the leading slash, e.g.
    // `/_build/assets/(root)-BV3LCSHm.js` -> `_build/assets/(root)-BV3LCSHm.js`.
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

    // Serve from the edge cache when we've seen this exact URL before.
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const object = await env.ASSETS.get(key);
    if (object === null) {
      // Not (yet) in R2: let the origin Node server answer. It always carries
      // the current build, so this covers the upload/deploy race window.
      return fetch(request);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    // Content-hashed filenames are immutable: cache hard, both at the edge and
    // in the browser.
    headers.set("cache-control", "public, max-age=31536000, immutable");

    const response = new Response(
      request.method === "HEAD" ? null : object.body,
      { headers },
    );
    // Populate the edge cache without blocking the response.
    if (request.method === "GET") {
      ctx.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
