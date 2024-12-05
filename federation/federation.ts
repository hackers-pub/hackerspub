import { getLogger } from "@logtape/logtape";
import { createFederation } from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import { RedisKvStore } from "@fedify/redis";
import { Redis } from "ioredis";
import { postgres } from "../db.ts";
import metadata from "../deno.json" with { type: "json" };
import { kvUrl } from "../kv.ts";
import { tracerProvider } from "../sentry.ts";

const logger = getLogger(["hackerspub", "federation"]);

const kv = kvUrl.protocol === "redis:"
  ? new RedisKvStore(
    new Redis(kvUrl.href, {
      family: kvUrl.hostname.endsWith(".upstash.io") ? 6 : 4,
    }),
  )
  : new PostgresKvStore(postgres);
logger.debug("KV store initialized: {kv}", { kv });

const queue = new PostgresMessageQueue(postgres);
logger.debug("Message queue initialized: {queue}", { queue });

export const federation = createFederation<void>({
  kv,
  queue,
  userAgent: {
    software: `HackersPup/${metadata.version}`,
  },
  tracerProvider,
});
