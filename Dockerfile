FROM docker.io/denoland/deno:alpine-2.1.2

RUN apk add --no-cache jq

WORKDIR /app
COPY fonts /app/fonts

COPY deno.json /app/deno.json
COPY deno.lock /app/deno.lock

RUN ["deno", "install"]

COPY . /app
RUN cp .env.sample .env && deno task build && rm .env

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

RUN jq '.version += "+" + $git_commit' --arg git_commit $GIT_COMMIT deno.json > /tmp/deno.json && \ 
  mv /tmp/deno.json deno.json

EXPOSE 8000
CMD ["deno", "task", "start"]
