import type { Redis } from "ioredis";
import { anonymousReadLedgerKey } from "../runtime/anonymous-read-admission.ts";

/** Provision only a fresh, per-run smoke origin, never the deployment origin. */
export async function provisionSmokeAdmissionLedger(
  client: Redis,
  origin: URL,
  limit: number,
): Promise<(drained: boolean) => Promise<void>> {
  const key = anonymousReadLedgerKey(origin);
  const created = await client.eval(
    `if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
redis.call('HSET', KEYS[1], 'format', '1', 'limit', ARGV[1])
return 1`,
    1,
    key,
    String(limit),
  );
  if (created !== 1) {
    throw new Error(`Smoke admission ledger already exists: ${key}`);
  }
  return async (drained) => {
    if (!drained) {
      throw new Error(`Smoke children did not drain; preserving ledger ${key}`);
    }
    // Never erase live or uncertain ownership, even for this isolated origin.
    const removed = await client.eval(
      `if redis.call('HLEN', KEYS[1]) ~= 2 or
redis.call('HGET', KEYS[1], 'format') ~= '1' or
redis.call('HGET', KEYS[1], 'limit') ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`,
      1,
      key,
      String(limit),
    );
    if (removed !== 1) {
      throw new Error(
        `Smoke admission ledger changed or still has owners: ${key}`,
      );
    }
  };
}
