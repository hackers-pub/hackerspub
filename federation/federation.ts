import { createFederation } from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import { RedisKvStore } from "@fedify/redis";
import { getLogger } from "@logtape/logtape";
import { Redis } from "ioredis";
import { postgres } from "../db.ts";
import metadata from "../deno.json" with { type: "json" };
import { kvUrl } from "../kv.ts";

const logger = getLogger(["hackerspub", "federation"]);

const origin = Deno.env.get("ORIGIN");
if (origin == null) {
  throw new Error("Missing ORIGIN environment variable.");
} else if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
  throw new Error("ORIGIN must start with http:// or https://");
}
export const ORIGIN = origin;

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
  origin: ORIGIN,
  userAgent: {
    software: `HackersPub/${metadata.version}`,
    url: new URL(ORIGIN),
  },
});
