FROM docker.io/denoland/deno:2.4.4

RUN apt-get update && apt-get install -y build-essential curl ffmpeg jq && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh && \
  bash nodesource_setup.sh && \
  apt-get install -y nodejs && \
  rm nodesource_setup.sh && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY web/fonts /app/web/fonts

COPY deno.json /app/deno.json
COPY ai/deno.json /app/ai/deno.json
COPY federation/deno.json /app/federation/deno.json
COPY graphql/deno.json /app/graphql/deno.json
COPY models/deno.json /app/models/deno.json
COPY web/deno.json /app/web/deno.json
COPY web-next/deno.jsonc /app/web-next/deno.jsonc
COPY web-next/package.json /app/web-next/package.json
COPY deno.lock /app/deno.lock

RUN ["deno", "install"]

COPY . /app
RUN cp .env.sample .env && \
  sed -i '/^INSTANCE_ACTOR_KEY=/d' .env && \
  echo >> .env && \
  echo "INSTANCE_ACTOR_KEY='$(deno task keygen)'" >> .env && \
  deno task -r codegen && \
  deno task build && \
  rm .env

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

RUN jq '.version += "+" + $git_commit' --arg git_commit $GIT_COMMIT federation/deno.json > /tmp/deno.json && \
  mv /tmp/deno.json federation/deno.json && \
  jq '.version += "+" + $git_commit' --arg git_commit $GIT_COMMIT graphql/deno.json > /tmp/deno.json && \
  mv /tmp/deno.json graphql/deno.json && \
  jq '.version += "+" + $git_commit' --arg git_commit $GIT_COMMIT models/deno.json > /tmp/deno.json && \
  mv /tmp/deno.json models/deno.json && \
  jq '.version += "+" + $git_commit' --arg git_commit $GIT_COMMIT web/deno.json > /tmp/deno.json && \
  mv /tmp/deno.json web/deno.json

EXPOSE 8000
CMD ["deno", "task", "start"]
