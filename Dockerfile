FROM docker.io/denoland/deno:alpine-2.1.2

WORKDIR /app
COPY fonts /app/fonts

COPY deno.json /app/deno.json
COPY deno.lock /app/deno.lock

RUN ["deno", "install"]

COPY . /app
RUN cp .env.sample .env && deno task build && rm .env

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

CMD ["deno", "task", "start"]
