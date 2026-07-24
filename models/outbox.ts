import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { type Database, runInTransaction, type Transaction } from "./db.ts";
import {
  type OutboxEvent,
  type OutboxEventError,
  outboxEventTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import type { Uuid } from "./uuid.ts";

export const OUTBOX_EVENT_TYPES = [
  "activitypub.fanout",
  "activitypub.delivery",
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
export type OutboxDatabase = Database | Transaction;

export interface OutboxEventInput {
  readonly eventType: OutboxEventType;
  readonly payloadVersion: number;
  readonly messageId: string;
  readonly payload: unknown;
  readonly activityId?: string;
  readonly activityType?: string;
  readonly inbox?: string;
}

export interface EnqueueOutboxOptions {
  readonly orderingKey?: string;
  readonly groupId?: Uuid;
  readonly sequence?: bigint;
  readonly position?: number;
  readonly now?: Date;
  readonly available?: Date;
}

export interface ClaimOutboxOptions {
  readonly now?: Date;
  readonly leaseDuration: Temporal.Duration | Temporal.DurationLike;
}

export interface RetryOutboxOptions {
  readonly payload: unknown;
  readonly available: Date;
  readonly error: OutboxEventError;
}

export interface OutboxDepth {
  readonly queued: number;
  readonly ready: number;
  readonly delayed: number;
}

/**
 * Move pending outgoing messages from Fedify's former shared PostgreSQL queue.
 * Inbox messages remain in place for the inbox queue to consume.
 */
export async function migrateLegacyOutboxEvents(
  db: OutboxDatabase,
): Promise<number> {
  const [legacyTable] = await db.execute<{ present: boolean }>(sql`
    select to_regclass('public.fedify_message_v2') is not null as present
  `);
  if (!legacyTable.present) return 0;

  return await runInTransaction(db, async (tx) => {
    // Prevent the legacy queue from changing its snapshot between the copy and
    // delete statements. The lock is held only while the pending rows move.
    await tx.execute(sql`
      lock table fedify_message_v2 in share row exclusive mode
    `);
    await tx.execute(sql`
      insert into outbox_event (
        id,
        event_type,
        payload_version,
        message_id,
        group_id,
        sequence,
        position,
        ordering_key,
        payload,
        activity_id,
        activity_type,
        inbox,
        available,
        created,
        updated
      )
      select
        gen_random_uuid(),
        case message->>'type'
          when 'fanout' then 'activitypub.fanout'
          else 'activitypub.delivery'
        end,
        1,
        message->>'id',
        gen_random_uuid(),
        nextval('outbox_event_sequence'),
        0,
        ordering_key,
        message,
        case when jsonb_typeof(message->'activityId') = 'string'
          then message->>'activityId'
        end,
        case when jsonb_typeof(message->'activityType') = 'string'
          then message->>'activityType'
        end,
        case when jsonb_typeof(message->'inbox') = 'string'
          then message->>'inbox'
        end,
        coalesce(created, current_timestamp) +
          coalesce(delay, interval '0 seconds'),
        coalesce(created, current_timestamp),
        current_timestamp
      from fedify_message_v2
      where jsonb_typeof(message) = 'object'
        and message->>'type' in ('fanout', 'outbox')
        and jsonb_typeof(message->'id') = 'string'
      order by created, id
      on conflict (event_type, message_id) do nothing
    `);
    const removed = await tx.execute<{ id: string }>(sql`
      delete from fedify_message_v2 as legacy
      where jsonb_typeof(legacy.message) = 'object'
        and legacy.message->>'type' in ('fanout', 'outbox')
        and jsonb_typeof(legacy.message->'id') = 'string'
        and exists (
          select 1
          from outbox_event as event
          where event.event_type = case legacy.message->>'type'
              when 'fanout' then 'activitypub.fanout'
              else 'activitypub.delivery'
            end
            and event.message_id = legacy.message->>'id'
        )
      returning legacy.id
    `);
    return removed.length;
  });
}

export type ClaimedOutboxEvent = OutboxEvent & {
  readonly status: "processing";
  readonly leaseToken: Uuid;
  readonly leased: Date;
};

function rowCount(rows: readonly unknown[]): boolean {
  return rows.length > 0;
}

async function nextSequence(db: OutboxDatabase): Promise<bigint> {
  const rows = (await db.execute(
    sql`select nextval('outbox_event_sequence')::text as sequence`,
  )) as unknown as Array<{ sequence: string }>;
  return BigInt(rows[0].sequence);
}

export async function enqueueOutboxEvents(
  db: OutboxDatabase,
  events: readonly OutboxEventInput[],
  options: EnqueueOutboxOptions = {},
): Promise<void> {
  if (events.length === 0) return;
  await runInTransaction(db, async (tx) => {
    if (options.orderingKey != null) {
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${options.orderingKey}, 0)
        )
      `);
    }
    const now = options.now ?? new Date();
    const groupId = options.groupId ?? generateUuidV7();
    const sequence = options.sequence ?? (await nextSequence(tx));
    await tx
      .insert(outboxEventTable)
      .values(
        events.map((event, index) => ({
          id: generateUuidV7(),
          ...event,
          groupId,
          sequence,
          position: (options.position ?? 0) + index,
          orderingKey: options.orderingKey,
          status: "pending" as const,
          available: options.available ?? now,
          created: now,
          updated: now,
        })),
      )
      .onConflictDoNothing({
        target: [outboxEventTable.eventType, outboxEventTable.messageId],
      });
  });
}

function mapOutboxRow(row: Record<string, unknown>): OutboxEvent {
  return {
    id: row.id as Uuid,
    eventType: row.event_type as string,
    payloadVersion: row.payload_version as number,
    messageId: row.message_id as string,
    groupId: row.group_id as Uuid,
    sequence: BigInt(row.sequence as string | number | bigint),
    position: row.position as number,
    orderingKey: row.ordering_key as string | null,
    status: row.status as OutboxEvent["status"],
    payload: row.payload,
    activityId: row.activity_id as string | null,
    activityType: row.activity_type as string | null,
    inbox: row.inbox as string | null,
    available: row.available as Date,
    processingAttempts: row.processing_attempts as number,
    leaseToken: row.lease_token as Uuid | null,
    leased: row.leased as Date | null,
    lastError: row.last_error as OutboxEventError | null,
    created: row.created as Date,
    updated: row.updated as Date,
    completed: row.completed as Date | null,
    failed: row.failed as Date | null,
  };
}

export async function claimOutboxEvent(
  db: OutboxDatabase,
  eventType: OutboxEventType,
  options: ClaimOutboxOptions,
): Promise<ClaimedOutboxEvent | null> {
  const now = options.now ?? new Date();
  const leaseMilliseconds = Temporal.Duration.from(options.leaseDuration).total(
    "milliseconds",
  );
  const expiredBefore = new Date(now.getTime() - leaseMilliseconds);
  const nowIso = now.toISOString();
  const expiredBeforeIso = expiredBefore.toISOString();
  const leaseToken = generateUuidV7();
  const rows = (await db.execute(sql`
    with candidate as (
      select event.id
      from outbox_event as event
      where event.event_type = ${eventType}
        and event.available <= ${nowIso}::timestamptz
        and (
          event.status = 'pending'
          or (
            event.status = 'processing'
            and event.leased <= ${expiredBeforeIso}::timestamptz
          )
        )
        and (
          event.ordering_key is null
          or (
            not exists (
              select 1
              from outbox_event as active
              where active.ordering_key = event.ordering_key
                and active.id <> event.id
                and active.status = 'processing'
                and active.leased > ${expiredBeforeIso}::timestamptz
            )
            and not exists (
              select 1
              from outbox_event as earlier
              where earlier.ordering_key = event.ordering_key
                and earlier.status in ('pending', 'processing')
                and (earlier.sequence, earlier.position) <
                  (event.sequence, event.position)
            )
          )
        )
      order by event.sequence, event.position
      limit 1
      for update skip locked
    )
    update outbox_event as event
    set status = 'processing',
        lease_token = ${leaseToken},
        leased = ${nowIso}::timestamptz,
        processing_attempts = event.processing_attempts + 1,
        updated = ${nowIso}::timestamptz
    from candidate
    where event.id = candidate.id
    returning event.*
  `)) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  return mapOutboxRow(rows[0]) as ClaimedOutboxEvent;
}

export async function completeOutboxEvent(
  db: OutboxDatabase,
  event: Pick<ClaimedOutboxEvent, "id" | "leaseToken">,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(outboxEventTable)
    .set({
      status: "completed",
      payload: null,
      leaseToken: null,
      leased: null,
      completed: now,
      updated: now,
    })
    .where(
      and(
        eq(outboxEventTable.id, event.id),
        eq(outboxEventTable.status, "processing"),
        eq(outboxEventTable.leaseToken, event.leaseToken),
      ),
    )
    .returning({ id: outboxEventTable.id });
  return rowCount(rows);
}

export async function retryOutboxEvent(
  db: OutboxDatabase,
  event: Pick<ClaimedOutboxEvent, "id" | "leaseToken">,
  options: RetryOutboxOptions,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(outboxEventTable)
    .set({
      status: "pending",
      payload: options.payload,
      available: options.available,
      leaseToken: null,
      leased: null,
      lastError: options.error,
      failed: null,
      updated: now,
    })
    .where(
      and(
        eq(outboxEventTable.id, event.id),
        eq(outboxEventTable.status, "processing"),
        eq(outboxEventTable.leaseToken, event.leaseToken),
      ),
    )
    .returning({ id: outboxEventTable.id });
  return rowCount(rows);
}

export async function failOutboxEvent(
  db: OutboxDatabase,
  event: Pick<ClaimedOutboxEvent, "id" | "leaseToken">,
  error: OutboxEventError,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(outboxEventTable)
    .set({
      status: "dead",
      leaseToken: null,
      leased: null,
      lastError: error,
      failed: now,
      updated: now,
    })
    .where(
      and(
        eq(outboxEventTable.id, event.id),
        eq(outboxEventTable.status, "processing"),
        eq(outboxEventTable.leaseToken, event.leaseToken),
      ),
    )
    .returning({ id: outboxEventTable.id });
  return rowCount(rows);
}

export async function replayOutboxEvent(
  db: OutboxDatabase,
  id: Uuid,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(outboxEventTable)
    .set({
      status: "pending",
      available: now,
      processingAttempts: 0,
      leaseToken: null,
      leased: null,
      completed: null,
      failed: null,
      updated: now,
    })
    .where(
      and(
        eq(outboxEventTable.id, id),
        eq(outboxEventTable.status, "dead"),
        isNotNull(outboxEventTable.payload),
      ),
    )
    .returning({ id: outboxEventTable.id });
  return rowCount(rows);
}

export async function renewOutboxLease(
  db: OutboxDatabase,
  event: Pick<ClaimedOutboxEvent, "id" | "leaseToken">,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(outboxEventTable)
    .set({
      leased: now,
      updated: now,
    })
    .where(
      and(
        eq(outboxEventTable.id, event.id),
        eq(outboxEventTable.status, "processing"),
        eq(outboxEventTable.leaseToken, event.leaseToken),
      ),
    )
    .returning({ id: outboxEventTable.id });
  return rowCount(rows);
}

export async function getOutboxDepth(
  db: OutboxDatabase,
  eventType: OutboxEventType,
  now = new Date(),
): Promise<OutboxDepth> {
  const rows = (await db.execute(sql`
    select
      count(*)::integer as queued,
      count(*) filter (
        where available <= ${now.toISOString()}::timestamptz
      )::integer as ready
    from outbox_event
    where event_type = ${eventType}
      and status = 'pending'
  `)) as unknown as Array<{ queued: number; ready: number }>;
  const queued = Number(rows[0].queued);
  const ready = Number(rows[0].ready);
  return { queued, ready, delayed: Math.max(0, queued - ready) };
}

export async function pruneOutboxEvents(
  db: OutboxDatabase,
  options: {
    readonly completedBefore: Date;
    readonly failedBefore: Date;
  },
): Promise<number> {
  const rows = await db
    .delete(outboxEventTable)
    .where(
      or(
        and(
          eq(outboxEventTable.status, "completed"),
          lt(outboxEventTable.completed, options.completedBefore),
        ),
        and(
          eq(outboxEventTable.status, "dead"),
          lt(outboxEventTable.failed, options.failedBefore),
        ),
      ),
    )
    .returning({ id: outboxEventTable.id });
  return rows.length;
}
