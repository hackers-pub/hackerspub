import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import { RedisKvStore } from "@fedify/redis";
import { builder } from "@hackerspub/federation";
import { getLogger } from "@logtape/logtape";
import { Redis } from "ioredis";
import { postgres } from "./db.ts";
import metadata from "./deno.json" with { type: "json" };
import { kvUrl } from "./kv.ts";

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

export const federation = await builder.build({
  kv,
  queue,
  origin: ORIGIN,
  // TODO: Revert to Fedify's default RFC 9421-first behavior once
  // https://github.com/bonfire-networks/activity_pub/issues/8 is fixed and
  // released.
  firstKnock: "draft-cavage-http-signatures-12",
  userAgent: {
    software: `HackersPub/${metadata.version}`,
    url: new URL(ORIGIN),
  },
});
