FROM docker.io/denoland/deno:2.2.12

RUN apt-get update && apt-get install -y build-essential ffmpeg jq && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY web/fonts /app/web/fonts

COPY .npmrc /app/.npmrc
COPY deno.json /app/deno.json
COPY federation/deno.json /app/federation/deno.json
COPY graphql/deno.json /app/graphql/deno.json
COPY models/deno.json /app/models/deno.json
COPY web/deno.json /app/web/deno.json
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
