Deployment
==========

This document describes how Hackers' Pub is deployed, how to cut over to a new
build, and how to roll one back.  For local development, read
[*CONTRIBUTING.md*](./CONTRIBUTING.md) instead.


Roles
-----

One container image serves three roles.  They are separate processes with
separate lifecycles, and the deployment definition chooses which role a
container runs and which probe watches it:

| Role   | Start command                  | Health check                      | Port |
| ------ | ------------------------------ | --------------------------------- | ---- |
| API    | `mise run prod:graphql`        | `mise run prod:hc:graphql`        | 8080 |
| Worker | `mise run prod:graphql-worker` | `mise run prod:hc:graphql-worker` | none |
| Web UI | `mise run prod:web-next`       | `mise run prod:hc:web-next`       | 3000 |

The image declares `HEALTHCHECK NONE` precisely because the probes differ per
role; a deployment that omits them gets no health signal at all.

> [!IMPORTANT]
> The worker must run as its own process and must never sit behind a load
> balancer.  It serves no HTTP surface, and its probe reads the heartbeat file
> at `WORKER_HEALTH_FILE` (default */tmp/hackerspub-graphql-worker.health*)
> rather than a port.  Its scheduled jobs coordinate through PostgreSQL locks,
> leases, and idempotent claims, so additional replicas are safe, but each
> needs its own heartbeat path.

The API and the worker must share one Redis instance through `KV_URL`.  A
file-backed `KV_URL` is a development-only convenience and will silently give
the two processes divergent state.


Images
------

CI builds and pushes on every merge to `main`:

 -  `ghcr.io/hackers-pub/hackerspub:git-<sha>` — the immutable release
    identifier.  **Deploy this, not `latest`,** so a rollback has something
    exact to return to.
 -  `ghcr.io/hackers-pub/hackerspub:latest` — a moving pointer to the newest
    build.
 -  `ghcr.io/hackers-pub/hackerspub:git-<sha>-amd64` and `-arm64` — the
    per-architecture images the manifest above fuses.

The build stamps `+<sha>` onto the version in *federation/package.json*,
*graphql/package.json*, *models/package.json*, and *web-next/package.json*, so
the running commit is visible through NodeInfo, the ActivityPub software
version, the outgoing user agent, and the Sentry release.


Cutover
-------

1.  Confirm CI is green for the commit you intend to deploy, and that
    `ghcr.io/hackers-pub/hackerspub:git-<sha>` exists.

2.  **Record the currently deployed image reference.**  Without it there is
    nothing to roll back to:

    ~~~~ sh
    docker inspect --format '{{.Config.Image}}' <running-container>
    ~~~~

    If that reports a moving tag such as `latest`, resolve the commit it is
    actually running and rebuild the immutable reference by hand:

    ~~~~ sh
    docker inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      <running-container>
    ~~~~

    The label holds the bare commit SHA, so the tag to record is
    `ghcr.io/hackers-pub/hackerspub:git-<sha>`.

3.  Pull the new image on the host.

4.  Run database migrations once, from the new image, before starting any
    service on it:

    ~~~~ sh
    mise run migrate
    ~~~~

    Installations upgraded from the removed Fresh application also need
    `mise run migrate:media` once; it is safe to repeat and never overwrites.

5.  Restart the roles in this order, waiting for each probe to pass before
    continuing: **worker → API → web UI.**  The worker first because it drains
    federation queues and is the only role that can be down without user-facing
    effect; the API before the web UI because the web UI proxies to it.

6.  Run the post-deploy checks below.

The API and worker shut down gracefully on `SIGTERM`: the API stops accepting
connections and drains in-flight requests, and the worker stops taking new
scheduled ticks, lets active jobs finish, and asks Fedify's queue listener to
stop.  Give them time to exit rather than killing them, or in-flight federation
work may be retried, and can be duplicated when a delivery completed before its
acknowledgement was recorded.  See [*FEDERATION.md*](./FEDERATION.md) for the
delivery guarantees this preserves.


Post-deploy checks
------------------

Each role's own probe:

~~~~ sh
mise run prod:hc:graphql
mise run prod:hc:graphql-worker
mise run prod:hc:web-next
~~~~

Then, against the public origin, the surfaces *scripts/smoke-standalone.ts*
already covers in CI.  These are the cheap ones, and a failure here means the
deployment is broken outright:

 -  `POST /graphql` with `{__typename}` returns
    `{"data":{"__typename":"Query"}}` and no `errors`.
 -  `/.well-known/nodeinfo` returns `application/jrd+json`.
 -  `/.well-known/assetlinks.json` and
    `/.well-known/apple-app-site-association` return `application/json`.
 -  `/search` renders.

Nothing automated covers the rest, so walk through it by hand:

 -  The NodeInfo document reports the version you just deployed.
 -  A profile and a post render, and their ActivityPub representations resolve.
 -  Sign-in by email and by passkey both work.
 -  A media upload succeeds and the uploaded file is served back.
 -  Sentry shows the new release and no new error class.
 -  A remote follow and an outbound delivery both complete.  The worker is the
    only process that delivers, so a worker that failed to start is invisible
    to every HTTP check above.


Rollback
--------

Roll back by redeploying the previously recorded image tag, in the same
worker → API → web UI order, then rerunning the post-deploy checks.

> [!CAUTION]
> Rollback is image-level only.  There is no second runtime to fall back to,
> because [#351] removed Deno: every `dev:*` and `prod:*` task runs Node.js.
>
> Database migrations are **not** reversed by rolling the image back.  If the
> deployment included a migration that the older image cannot tolerate, restore
> the database from backup instead, and treat the rollback as a data-loss
> window that has to be planned rather than improvised.

Rehearse this before you need it: deploy the current tag, then redeploy the
previous one, and confirm the checks pass at both ends.

[#351]: https://github.com/hackers-pub/hackerspub/issues/351
