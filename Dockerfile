# --- Builder stage ---------------------------------------------------------
FROM docker.io/debian:13-slim AS builder

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

COPY web/fonts /app/web/fonts

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

RUN pnpm install --frozen-lockfile
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

# `--mount=type=secret,id=sentry_auth_token,...` exposes
# SENTRY_AUTH_TOKEN to this RUN step only. The value is never written to
# any image layer, so the public image stays free of the secret. CI
# provides the secret via docker/build-push-action's `secrets:` input
# (see .github/workflows/main.yml). Without the secret the build still
# succeeds — the Sentry Vite plugin (vite.config.ts) just skips its
# source-map upload when SENTRY_AUTH_TOKEN is unset.
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
  cp .env.sample .env && \
  sed -i '/^INSTANCE_ACTOR_KEY=/d' .env && \
  echo >> .env && \
  echo "INSTANCE_ACTOR_KEY='$(mise run keygen)'" >> .env && \
  deno task -r codegen && \
  deno task build && \
  pnpm --filter @hackerspub/web-next build && \
  rm .env

# Drop devDependencies from node_modules. A clean reinstall in --prod mode
# is more reliable than `pnpm prune --prod` against a workspace that's
# already had its devDependencies pulled (e.g. Storybook, relay-compiler,
# vite plugins). Run after web-next build because the build needs them.
RUN rm -rf node_modules web-next/node_modules && \
  pnpm install --frozen-lockfile --prod

# Re-populate /app/node_modules entries that Deno needs but pnpm doesn't
# track. The previous step (rm -rf node_modules + pnpm install --prod)
# wipes everything Deno had pulled in via deno.json (drizzle-kit, the
# graphql server's npm dependencies like graphql-yoga / pothos / fedify,
# etc.). Without this re-population the first `mise run prod:graphql`
# at deploy time spends minutes rebuilding the directory; with it the
# server starts in seconds.
RUN deno install

# --- Runtime stage ---------------------------------------------------------
FROM docker.io/debian:13-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Runtime needs ffmpeg (media processing) and ca-certificates (HTTPS).
# build-essential, curl, jq, etc. stay in the builder stage only.
RUN apt-get update && apt-get -y --no-install-recommends install \
  ca-certificates ffmpeg && \
  rm -rf /var/lib/apt/lists/*

ENV MISE_DATA_DIR="/mise"
ENV MISE_CONFIG_DIR="/mise"
ENV MISE_CACHE_DIR="/mise/cache"
ENV MISE_INSTALL_PATH="/usr/local/bin/mise"
ENV PATH="/mise/shims:$PATH"

# mise binary plus its data dir (tool installs, shims, trusted-config state).
COPY --from=builder /usr/local/bin/mise /usr/local/bin/mise
COPY --from=builder /mise /mise

# Deno keeps its module cache at $HOME/.cache/deno; ship it so the runtime
# doesn't need network access to resolve imports.
COPY --from=builder /root/.cache/deno /root/.cache/deno

WORKDIR /app
COPY --from=builder /app /app

# Re-trust the config in the runtime stage. mise stores trust state under
# the user's home (not MISE_DATA_DIR), and we don't carry that over.
RUN mise trust /app/mise.toml

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["mise", "run", "prod:hc:web"]
CMD ["mise", "run", "prod:web"]
