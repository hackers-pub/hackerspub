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

// Raise the message handler timeout above the 60-second default: inbox
// handlers may legitimately need several bounded remote fetches, and the
// default tripped on slow federation peers (see GRAPHQL-1H).  The real fix is
// bounding each remote fetch (see `withDocumentLoaderTimeout` in
// `@hackerspub/models/post`); this is headroom so transient slowness no longer
// surfaces as a handler timeout.
const queue = new PostgresMessageQueue(postgres, {
  handlerTimeout: { seconds: 180 },
});
logger.debug("Message queue initialized: {queue}", { queue });

export const federation = await builder.build({
  kv,
  queue,
  // Do NOT auto-consume the queue here.  This federation is imported by both
  // the public API process (`main.ts`, which serves HTTP and enqueues) and the
  // dedicated worker process (`worker.ts`, which calls `startQueue`).  Draining
  // the inbox/outbox in the API process put queue load (slow remote fetches,
  // handler-timeout zombies) on the same event loop and DB pool as user-facing
  // GraphQL requests, which is what tipped them into Caddy 504s (WEB-NEXT-1W).
  manuallyStartQueue: true,
  origin: ORIGIN,
  userAgent: {
    software: `HackersPub/${metadata.version}`,
    url: new URL(ORIGIN),
  },
});
