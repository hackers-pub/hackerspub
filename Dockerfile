FROM docker.io/denoland/deno:2.2.10

RUN apt-get update && apt-get install -y build-essential ffmpeg jq && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY fonts /app/fonts

COPY deno.json /app/deno.json
COPY deno.lock /app/deno.lock

RUN ["deno", "install"]

COPY . /app
RUN cp .env.sample .env && \
  echo >> .env && \
  echo "INSTANCE_ACTOR_KEY='$(deno task keygen)'" >> .env && \
  deno task build && \
  rm .env

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

RUN jq '.version += "+" + $git_commit' --arg git_commit $GIT_COMMIT deno.json > /tmp/deno.json && \
  mv /tmp/deno.json deno.json

EXPOSE 8000
CMD ["deno", "task", "start"]
