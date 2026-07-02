asset-cdn
=========

A Cloudflare Worker that serves web-next's content-hashed client assets
(`/_build/assets/*`) for `hackers.pub` from a Cloudflare R2 bucket, so a
browser tab loaded against an *old* deploy can still lazily import its route
chunks after the container image (which only carries the current build) is
replaced.

See `src/index.ts` for the full rationale. In short:

 -  CI mirrors every build's `_build/assets/*` into R2 without deleting old
    objects (`.github/workflows/main.yml`, job `upload-assets`). Content-hashed
    filenames never collide, so R2 accumulates every deploy's chunks.
 -  This Worker, routed at `hackers.pub/_build/assets/*` and bound to that
    bucket, serves the objects with long-lived immutable caching and an edge
    cache, falling back to the origin Node server on a miss (which also makes
    deploys race-free).

This fixes Sentry issue WEB-NEXT-C
(`TypeError: error loading dynamically imported module`).


One-time setup
--------------

These steps are done by hand (they need access to your Cloudflare and GitHub
accounts). The Worker code, its route, and the CI upload job are already in the
repo.

1.  **Create the R2 bucket.** In the Cloudflare dashboard (R2) create a bucket
    named `hackerspub-assets` (or pick another name and update `bucket_name` in
    `wrangler.toml` plus the `R2_BUCKET` variable below). Keep it **private**;
    it is reached only through the Worker binding and the S3 API, never
    publicly.

2.  **(Recommended) Add a lifecycle rule** on the bucket to expire objects some
    time after upload (e.g. 90 days). Old chunks only need to outlive the
    longest-lived open browser tab; this keeps storage bounded.

3.  **Create an R2 API token** (R2 -> Manage API Tokens -> S3 Auth /
    Access Key) with Object Read & Write on the bucket. Note the Access Key ID,
    Secret Access Key, and your account's S3 endpoint
    (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).

4.  **Add GitHub repository secrets** (Settings -> Secrets and variables ->
    Actions -> Secrets):
     -  `R2_ACCESS_KEY_ID`
     -  `R2_SECRET_ACCESS_KEY`
     -  `R2_S3_ENDPOINT` (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`)

5.  **Add GitHub repository variables** (same screen -> Variables):
     -  `R2_BUCKET` = `hackerspub-assets`
     -  `R2_ASSET_UPLOAD` = `true`  (this flips the upload job on; until set, CI
        skips it so nothing breaks before the bucket exists)

6.  **Deploy the Worker:** this package is a pnpm workspace member, so install
    once from the repo root (`pnpm install`), then deploy from this directory
    with a Cloudflare API token that can edit Workers and the `hackers.pub`
    zone:

    ~~~~ sh
    export CLOUDFLARE_API_TOKEN=...   # Workers Scripts:Edit + zone Workers Routes:Edit
    pnpm --filter @hackerspub/asset-cdn exec wrangler deploy
    ~~~~

    `wrangler` reads the R2 binding and the route from `wrangler.toml`.

7.  **Seed the bucket with the current build** so existing tabs are covered
    immediately, instead of waiting for the next push to main. Either re-run
    the latest `main` workflow after step 5, or upload once locally:

    ~~~~ sh
    # from the repo root, against a current production build
    aws s3 sync web-next/.output/public/_build "s3://hackerspub-assets/_build" \
      --endpoint-url "$R2_S3_ENDPOINT" \
      --cache-control "public, max-age=31536000, immutable"
    ~~~~


Verifying
---------

After deploy, load `https://hackers.pub/` and check in DevTools that a
`/_build/assets/*.js` request is served by the Worker (response header
`cf-cache-status` present, and it succeeds independently of the origin). The
existing `vite:preloadError` auto-reload in `web-next/src/entry-client.tsx`
remains as a backstop for cross-version API/schema incompatibilities.
