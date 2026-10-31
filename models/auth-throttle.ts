import { sql } from "drizzle-orm";
import type { Database } from "./db.ts";

export interface AuthThrottleResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

/**
 * Atomically consume one slot in a fixed-window throttle.  The row lock makes
 * this safe across API replicas; callers must use a stable key per subject and
 * window class.
 */
export async function consumeAuthThrottle(
  db: Database,
  key: string,
  limit: number,
  windowMilliseconds: number,
  now = new Date(),
): Promise<AuthThrottleResult> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Throttle limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(windowMilliseconds) || windowMilliseconds < 1) {
    throw new TypeError("Throttle window must be a positive integer.");
  }
  const nowIso = now.toISOString();
  // The longest throttle window is one hour; one day is a safe privacy cutoff.
  await db.execute(sql`
    delete from auth_throttle
    where window_start < ${nowIso}::timestamptz - interval '1 day'
  `);
  const [row] = (await db.execute<{
    count: number;
    retry_after: number;
  }>(sql`
    with upsert as (
      insert into auth_throttle (key, window_start, count)
      values (${key}, ${nowIso}::timestamptz, 1)
      on conflict (key) do update
        set count = case
              when auth_throttle.window_start <=
                ${nowIso}::timestamptz
                  - (${windowMilliseconds}::int * interval '1 millisecond')
                then 1
              else auth_throttle.count + 1
            end,
            window_start = case
              when auth_throttle.window_start <=
                ${nowIso}::timestamptz
                  - (${windowMilliseconds}::int * interval '1 millisecond')
                then ${nowIso}::timestamptz
              else auth_throttle.window_start
            end
      returning count, window_start
    )
    select
      count,
      greatest(
        0,
        ceil(extract(epoch from (
          window_start
            + (${windowMilliseconds}::int * interval '1 millisecond')
            - ${nowIso}::timestamptz
        )))::int
      ) as retry_after
    from upsert
  `)) as unknown as { count: number; retry_after: number }[];
  if (row == null) return { allowed: false, retryAfterSeconds: 1 };
  return {
    allowed: row.count <= limit,
    retryAfterSeconds: row.retry_after,
  };
}
