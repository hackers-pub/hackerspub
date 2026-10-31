import { eq, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import { type EmailPriority, emailSendTable } from "./schema.ts";
import type { Uuid } from "./uuid.ts";

/**
 * Arbitrary fixed advisory-lock key shared by every process that admits mail.
 * "emai" as a 32-bit integer.
 */
const EMAIL_BUDGET_LOCK_KEY = 0x656d6169;

export interface EmailBudgetLimits {
  readonly hourlyLimit: number;
  readonly hourlyHeadroom: number;
  readonly authReserve: number;
  readonly digestHourlyCap: number;
  readonly monthlyLimit: number;
  readonly monthlyAuthReserve: number;
}

export interface EmailBudgetUsage {
  /** When an admitted slot first becomes available again. */
  readonly nextAvailable: Date;
  readonly total: number;
  readonly auth: number;
  readonly nonAuth: number;
  readonly digest: number;
  readonly month: Date;
  readonly monthlyTotal: number;
  readonly monthlyAuth: number;
  readonly monthlyNonAuth: number;
}

export interface EmailSendMetadata {
  readonly accountId?: Uuid;
  readonly deliveryFrequency?: "daily" | "weekly";
  readonly deliveryPeriod?: Date;
  /** One hash per admitted recipient, in the same order as the admissions. */
  readonly recipientHashes?: readonly string[];
}

export interface AdmittedEmailSend {
  readonly id: string;
  readonly priority: EmailPriority;
}

export interface EmailSendOutcome {
  /** `null` means the provider outcome is ambiguous (timeout/crash). */
  readonly accepted: boolean | null;
  readonly providerRef?: string | null;
}

interface UsageRow extends Record<string, unknown> {
  total: number;
  auth: number;
  non_auth: number;
  digest: number;
  oldest: Date | string | null;
}

interface MonthlyUsageRow extends Record<string, unknown> {
  total: number;
  auth: number;
  non_auth: number;
}

export async function admitEmailSends(
  db: Database,
  priority: EmailPriority,
  count: number,
  limits: EmailBudgetLimits,
  metadata: EmailSendMetadata = {},
): Promise<readonly AdmittedEmailSend[] | null> {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new TypeError("Email admission count must be a positive integer.");
  }
  if (
    metadata.recipientHashes != null &&
    metadata.recipientHashes.length !== count
  ) {
    throw new TypeError("Expected one recipient hash per admitted message.");
  }

  return await db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(${EMAIL_BUDGET_LOCK_KEY}::int)`,
    );

    const [usage] = (await tx.execute<UsageRow>(sql`
      select
        count(*) filter (
          where admitted > clock_timestamp() - interval '1 hour'
        )::int as total,
        count(*) filter (
          where admitted > clock_timestamp() - interval '1 hour'
            and priority = 'auth'
        )::int as auth,
        count(*) filter (
          where admitted > clock_timestamp() - interval '1 hour'
            and priority <> 'auth'
        )::int as non_auth,
        count(*) filter (
          where admitted > clock_timestamp() - interval '1 hour'
            and priority = 'digest'
        )::int as digest
      from email_send
    `)) as unknown as UsageRow[];

    const [monthly] = (await tx.execute<MonthlyUsageRow>(sql`
      select
        coalesce(sum(sent), 0)::int as total,
        coalesce(
          sum(sent) filter (where priority = 'auth'),
          0
        )::int as auth,
        coalesce(
          sum(sent) filter (where priority <> 'auth'),
          0
        )::int as non_auth
      from email_send_month
      where month = (date_trunc('month', now() at time zone 'utc'))::date
    `)) as unknown as MonthlyUsageRow[];

    const totalCap = limits.hourlyLimit - limits.hourlyHeadroom;
    if (totalCap < 1 || usage.total + count > totalCap) return null;
    if (
      priority !== "auth" &&
      usage.non_auth + count > totalCap - limits.authReserve
    ) {
      return null;
    }
    if (
      priority === "digest" &&
      usage.digest + count > limits.digestHourlyCap
    ) {
      return null;
    }
    if (monthly.total + count > limits.monthlyLimit) return null;
    if (
      priority !== "auth" &&
      monthly.non_auth + count > limits.monthlyLimit - limits.monthlyAuthReserve
    ) {
      return null;
    }

    const rows = await tx
      .insert(emailSendTable)
      .values(
        Array.from({ length: count }, (_, index) => ({
          priority,
          ...(metadata.accountId == null
            ? {}
            : { accountId: metadata.accountId }),
          ...(metadata.deliveryFrequency == null
            ? {}
            : { deliveryFrequency: metadata.deliveryFrequency }),
          ...(metadata.deliveryPeriod == null
            ? {}
            : { deliveryPeriod: metadata.deliveryPeriod }),
          ...(metadata.recipientHashes?.[index] == null
            ? {}
            : { recipientHash: metadata.recipientHashes[index] }),
        })),
      )
      .returning({ id: emailSendTable.id, priority: emailSendTable.priority });

    await tx.execute(sql`
      insert into email_send_month (month, priority, sent)
      values (
        (date_trunc('month', now() at time zone 'utc'))::date,
        ${priority},
        ${count}
      )
      on conflict (month, priority) do update
        set sent = email_send_month.sent + excluded.sent,
            updated = now()
    `);

    return rows as readonly AdmittedEmailSend[];
  });
}

/**
 * Marks an admission as submitted and records its provider outcome.
 * A bookkeeping failure must not make the caller retry a message that the
 * provider already accepted.
 */
export async function finishEmailSend(
  db: Database,
  id: string,
  outcome: EmailSendOutcome,
): Promise<void> {
  await db
    .update(emailSendTable)
    .set({
      submitted: sql`coalesce(${emailSendTable.submitted}, CURRENT_TIMESTAMP)`,
      accepted: outcome.accepted,
      providerRef: outcome.providerRef ?? null,
      finished: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(emailSendTable.id, id));
}

/**
 * Releases an admission only before any provider request could have been
 * issued. Once `submitted` is set, the slot stays charged.
 */
export async function releaseEmailSend(
  db: Database,
  id: string,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${EMAIL_BUDGET_LOCK_KEY}::int)`,
    );
    const [row] = await tx
      .select({
        priority: emailSendTable.priority,
        admitted: emailSendTable.admitted,
        submitted: emailSendTable.submitted,
        accepted: emailSendTable.accepted,
      })
      .from(emailSendTable)
      .where(eq(emailSendTable.id, id))
      .for("update");
    if (row == null || row.submitted != null || row.accepted != null) {
      return false;
    }
    const deleted = await tx
      .delete(emailSendTable)
      .where(eq(emailSendTable.id, id))
      .returning({ id: emailSendTable.id });
    if (deleted.length < 1) return false;
    await tx.execute(sql`
      update email_send_month
      set sent = greatest(sent - 1, 0), updated = now()
      where month = (date_trunc(
        'month',
        ${row.admitted.toISOString()}::timestamptz at time zone 'utc'
      ))::date
        and priority = ${row.priority}
    `);
    return true;
  });
}

export async function getEmailBudgetUsage(
  db: Database,
  now = new Date(),
): Promise<EmailBudgetUsage> {
  const [usage] = (await db.execute<UsageRow>(sql`
    select
      count(*) filter (
        where admitted > ${now.toISOString()}::timestamptz - interval '1 hour'
      )::int as total,
      count(*) filter (
        where admitted > ${now.toISOString()}::timestamptz - interval '1 hour'
          and priority = 'auth'
      )::int as auth,
      count(*) filter (
        where admitted > ${now.toISOString()}::timestamptz - interval '1 hour'
          and priority <> 'auth'
      )::int as non_auth,
      count(*) filter (
        where admitted > ${now.toISOString()}::timestamptz - interval '1 hour'
          and priority = 'digest'
      )::int as digest,
      min(admitted) filter (
        where admitted > ${now.toISOString()}::timestamptz - interval '1 hour'
      ) as oldest
    from email_send
  `)) as unknown as UsageRow[];

  const [monthly] = (await db.execute<MonthlyUsageRow>(sql`
    select
      coalesce(sum(sent), 0)::int as total,
      coalesce(sum(sent) filter (where priority = 'auth'), 0)::int as auth,
      coalesce(
        sum(sent) filter (where priority <> 'auth'),
        0
      )::int as non_auth
    from email_send_month
    where month = (date_trunc(
      'month',
      ${now.toISOString()}::timestamptz at time zone 'utc'
    ))::date
  `)) as unknown as MonthlyUsageRow[];

  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const oldest = usage?.oldest;
  return {
    nextAvailable:
      oldest == null ? now : new Date(new Date(oldest).getTime() + 3_600_000),
    total: usage?.total ?? 0,
    auth: usage?.auth ?? 0,
    nonAuth: usage?.non_auth ?? 0,
    digest: usage?.digest ?? 0,
    month,
    monthlyTotal: monthly?.total ?? 0,
    monthlyAuth: monthly?.auth ?? 0,
    monthlyNonAuth: monthly?.non_auth ?? 0,
  };
}

export function nextEmailBudgetReset(now = new Date()): Date {
  const reset = new Date(now);
  reset.setUTCMinutes(0, 0, 0);
  reset.setUTCHours(reset.getUTCHours() + 1);
  return reset;
}

export async function pruneEmailSends(
  db: Database,
  before: Date,
): Promise<number> {
  const rows = await db
    .delete(emailSendTable)
    .where(sql`${emailSendTable.admitted} < ${before.toISOString()}`)
    .returning({ id: emailSendTable.id });
  return rows.length;
}
