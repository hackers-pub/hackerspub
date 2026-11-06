import { createHash } from "node:crypto";
import { Redis } from "ioredis";

export interface AnonymousReadStore {
  acquire(owner: string): Promise<boolean>;
  release(owner: string): Promise<void>;
  close(): Promise<void>;
  readonly failure?: string;
}

/** The key is stable across API replicas sharing the same canonical origin. */
export function anonymousReadLedgerKey(origin: URL): string {
  const hash = createHash("sha256").update(origin.origin).digest("hex");
  return `hackerspub:anonymous-read:v1:${hash}`;
}

export function createMemoryAnonymousReadStore(
  limit: number,
): AnonymousReadStore {
  const owners = new Set<string>();
  let closed = false;
  return {
    async acquire(owner) {
      if (closed) throw new Error("Anonymous read store is closed");
      if (owners.has(owner)) throw new Error("Duplicate admission owner");
      if (owners.size >= limit) return false;
      owners.add(owner);
      return true;
    },
    async release(owner) {
      if (!owners.delete(owner)) throw new Error("Unknown admission owner");
    },
    async close() {
      closed = true;
    },
  };
}

// Never bootstrap this key from a serving API process. A missing marker may
// mean Redis lost live ownership records. The ledger must be initialized while
// all API processes and their downstream work are drained.
const ACQUIRE = `
if redis.call('HGET', KEYS[1], 'format') ~= '1' or redis.call('HGET', KEYS[1], 'limit') ~= ARGV[1] then return -1 end
if redis.call('HEXISTS', KEYS[1], 'owner:' .. ARGV[2]) == 1 then return -2 end
if redis.call('HLEN', KEYS[1]) - 2 >= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'owner:' .. ARGV[2], '1')
return 1`;
const RELEASE = `
if redis.call('HGET', KEYS[1], 'format') ~= '1' or redis.call('HGET', KEYS[1], 'limit') ~= ARGV[1] then return -1 end
return redis.call('HDEL', KEYS[1], 'owner:' .. ARGV[2])`;

/** A dedicated client that permanently fails closed on any uncertain command. */
export async function createRedisAnonymousReadStore(
  url: URL,
  origin: URL,
  limit: number,
  timeoutMs: number,
): Promise<AnonymousReadStore> {
  const client = new Redis(url.href, {
    lazyConnect: true,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    retryStrategy: () => null,
    reconnectOnError: () => false,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    maxRetriesPerRequest: 0,
    family: url.hostname.endsWith(".upstash.io") ? 6 : 4,
  });
  let failure: string | undefined;
  let closed = false;
  const fail = (reason: string) => {
    failure ??= reason;
    client.disconnect();
  };
  client.on("error", () => fail("redis_error"));
  client.on("close", () => {
    if (!closed) fail("redis_disconnected");
  });
  try {
    await client.connect();
  } catch {
    fail("redis_connect_failed");
  }
  const key = anonymousReadLedgerKey(origin);
  async function command(script: string, owner: string): Promise<number> {
    if (failure != null || closed)
      throw new Error("Anonymous read ledger unavailable");
    try {
      const result = await client.eval(script, 1, key, String(limit), owner);
      if (failure != null || closed)
        throw new Error("Anonymous read ledger unavailable");
      if (typeof result !== "number" || result < 0) {
        fail(result === -1 ? "ledger_missing_or_mismatched" : "invalid_owner");
        throw new Error("Anonymous read ledger invalid");
      }
      return result;
    } catch (error) {
      fail("redis_command_failed");
      throw error;
    }
  }
  return {
    get failure() {
      return failure;
    },
    async acquire(owner) {
      return (await command(ACQUIRE, owner)) === 1;
    },
    async release(owner) {
      if ((await command(RELEASE, owner)) !== 1) {
        fail("unknown_owner");
        throw new Error("Anonymous read owner missing");
      }
    },
    async close() {
      closed = true;
      client.disconnect();
    },
  };
}
