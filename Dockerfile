# syntax=docker/dockerfile:1
# `env=` for `--mount=type=secret` was added in dockerfile frontend 1.10
# (Sep 2024); pinning to `:1` follows the latest stable major.
# --- Builder base ----------------------------------------------------------
# Tools + apt deps that builder/manifests/deps-prod/builder all share. Keeping
# this stage cache-stable (apt list never changes mid-PR) means downstream
# stages start from the same hashed parent on every build.
FROM docker.io/debian:13-slim AS builder-base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get -y --no-install-recommends install \
  build-essential ca-certificates curl ffmpeg jq && \
  rm -rf /var/lib/apt/lists/*

ENV MISE_DATA_DIR="/mise"
ENV MISE_CONFIG_DIR="/mise"
ENV MISE_CACHE_DIR="/mise/cache"
ENV MISE_INSTALL_PATH="/usr/local/bin/mise"
ENV PATH="/mise/shims:$PATH"

RUN curl https://mise.run | sh

WORKDIR /app
COPY mise.toml /app/mise.toml
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN \
  mise trust && mise install

# --- Manifests --------------------------------------------------------------
# Just the lockfiles + per-package manifests + patches, so deps-prod and
# builder share an identical "manifests-only" parent. This stage is keyed
# only on those files; bumping a lockfile invalidates here, source-only
# changes do not.
FROM builder-base AS manifests

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml /app/
COPY deno.json /app/deno.json
COPY deno.lock /app/deno.lock
COPY ai/deno.json /app/ai/deno.json
COPY ai/package.json /app/ai/package.json
COPY federation/deno.json /app/federation/deno.json
COPY federation/package.json /app/federation/package.json
COPY graphql/deno.json /app/graphql/deno.json
COPY models/deno.json /app/models/deno.json
COPY models/package.json /app/models/package.json
COPY web/deno.json /app/web/deno.json
COPY web-next/deno.jsonc /app/web-next/deno.jsonc
COPY web-next/package.json /app/web-next/package.json
COPY patches /app/patches

# --- Production deps --------------------------------------------------------
# Builds in parallel with the `builder` stage. Produces /app/**/node_modules
# with prod-only dependencies, plus /root/.cache/deno populated with whatever
# deno install needs at runtime. The pnpm-store cache mount re-uses already
# downloaded packages across builds even when the lockfile changed slightly
# (pnpm 10's default `package-import-method=auto` falls back to copy when the
# store and node_modules sit on different filesystems, so node_modules in the
# layer stays self-contained after the mount unmounts).
FROM manifests AS deps-prod

RUN --mount=type=cache,target=/root/.local/share/pnpm/store,id=pnpm-store,sharing=locked \
  pnpm install --frozen-lockfile --prod

# Re-populate the npm dependencies that Deno tracks but pnpm doesn't (the
# graphql server pulls graphql-yoga / pothos / fedify via deno.json, etc.).
# Without this the first `mise run prod:graphql` at deploy time spends
# minutes rebuilding /app/node_modules entries.
#
# No cache mount here: `/root/.cache/deno` must persist in this stage's layer
# because the runtime stage copies it out (`COPY --from=deps-prod /root/.cache/deno`).
# A `type=cache` mount would be unmounted at RUN-end, leaving the directory
# empty in the layer and reintroducing the multi-minute first-start download.
RUN deno install

# --- Builder ----------------------------------------------------------------
# Has dev dependencies installed; runs codegen + the actual build. Strips
# every node_modules at the end so the runtime stage can layer deps-prod's
# prod-only node_modules on top without leftover dev packages bleeding
# through.
FROM manifests AS builder

RUN --mount=type=cache,target=/root/.local/share/pnpm/store,id=pnpm-store,sharing=locked \
  pnpm install --frozen-lockfile

# No cache mount here either: the next RUN (codegen + build) reads
# `/root/.cache/deno` populated by this step. A mount would be unmounted at
# RUN-end and leave the build to re-download every npm/jsr/https module.
RUN deno install

COPY . /app

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

# Append "+<git_commit>" to each manifest's version *before* the build so the
# built artifacts that inline the version (notably web-next, where Vite bakes
# package.json into the SSR bundle) carry the commit hash too.
RUN if [ -n "$GIT_COMMIT" ]; then \
  jq '.version += "+" + $git_commit' --arg git_commit "$GIT_COMMIT" federation/deno.json > /tmp/deno.json && \
  mv /tmp/deno.json federation/deno.json && \
  jq '.version += "+" + $git_commit' --arg git_commit "$GIT_COMMIT" graphql/deno.json > /tmp/deno.json && \
  mv /tmp/deno.json graphql/deno.json && \
  jq '.version += "+" + $git_commit' --arg git_commit "$GIT_COMMIT" models/deno.json > /tmp/deno.json && \
  mv /tmp/deno.json models/deno.json && \
  jq '.version += "+" + $git_commit' --arg git_commit "$GIT_COMMIT" web/deno.json > /tmp/deno.json && \
  mv /tmp/deno.json web/deno.json && \
  jq '.version += "+" + $git_commit' --arg git_commit "$GIT_COMMIT" web-next/package.json > /tmp/package.json && \
  mv /tmp/package.json web-next/package.json \
  ; fi

# `--mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN` exposes
# the secret directly as $SENTRY_AUTH_TOKEN for this RUN step only. The
# value is never written to any image layer, so the public image stays
# free of the secret. CI provides the secret via docker/build-push-action's
# `secrets:` input (see .github/workflows/main.yml). Fork PRs have no
# access to the secret, so the var simply stays unset and the Sentry Vite
# plugin (vite.config.ts) skips its source-map upload.
#
# Requires dockerfile frontend ≥1.10 (the `env=` key was added there) — the
# `# syntax=docker/dockerfile:1` directive at the top of this file pins to
# the latest stable major, so this resolves to a compatible version.
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
  cp .env.sample .env && \
  sed -i '/^INSTANCE_ACTOR_KEY=/d' .env && \
  echo >> .env && \
  echo "INSTANCE_ACTOR_KEY='$(mise run keygen)'" >> .env && \
  deno task -r codegen && \
  deno task build && \
  pnpm --filter @hackerspub/web-next build && \
  rm .env

# Strip every node_modules in the workspace so the runtime stage layers
# deps-prod's prod-only node_modules on top without dev packages bleeding
# through. We avoid `pnpm prune --prod` here because the workspace already
# has its devDependencies pulled (Storybook, relay-compiler, vite plugins,
# …) and prune is unreliable in that state.
RUN find /app -name node_modules -type d -prune -exec rm -rf {} +

# --- Runtime ---------------------------------------------------------------
FROM docker.io/debian:13-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Runtime needs ffmpeg (media processing) and ca-certificates (HTTPS).
# build-essential, curl, jq, etc. stay in the builder stages only.
RUN apt-get update && apt-get -y --no-install-recommends install \
  ca-certificates ffmpeg && \
  rm -rf /var/lib/apt/lists/*

ENV MISE_DATA_DIR="/mise"
ENV MISE_CONFIG_DIR="/mise"
ENV MISE_CACHE_DIR="/mise/cache"
ENV MISE_INSTALL_PATH="/usr/local/bin/mise"
ENV PATH="/mise/shims:$PATH"

# mise binary plus its data dir (tool installs, shims, trusted-config state).
COPY --from=builder-base /usr/local/bin/mise /usr/local/bin/mise
COPY --from=builder-base /mise /mise

# Deno keeps its module cache at $HOME/.cache/deno; ship deps-prod's copy
# (it's the one whose install matches the prod node_modules layout).
COPY --from=deps-prod /root/.cache/deno /root/.cache/deno

WORKDIR /app
# Order matters: deps-prod first lays down manifests + prod node_modules.
# builder then layers on source + build artifacts. builder has stripped
# node_modules in its previous step, so the prod node_modules from
# deps-prod survive untouched. Manifests in builder carry the
# version-stamped jq edit, so the second COPY correctly overwrites the
# unstamped originals from deps-prod.
COPY --from=deps-prod /app /app
COPY --from=builder /app /app

# Re-trust the config in the runtime stage. mise stores trust state under
# the user's home (not MISE_DATA_DIR), and we don't carry that over.
RUN mise trust /app/mise.toml

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["mise", "run", "prod:hc:web"]
CMD ["mise", "run", "prod:web"]
