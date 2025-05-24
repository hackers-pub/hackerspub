import type { RequestContext } from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import { RedisKvStore } from "@fedify/redis";
import { builder } from "@hackerspub/federation";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
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
  userAgent: {
    software: `HackersPub/${metadata.version}`,
    url: new URL(ORIGIN),
  },
});

export async function withTransaction<T>(
  context: RequestContext<ContextData>,
  callback: (context: RequestContext<ContextData<Transaction>>) => Promise<T>,
) {
  return await context.data.db.transaction(async (transaction) => {
    const nextContext = federation.createContext(context.request, {
      ...context.data,
      db: transaction,
    }) as RequestContext<ContextData<Transaction>>;
    return await callback(nextContext);
  });
}
