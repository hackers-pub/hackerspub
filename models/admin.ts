import { getLogger } from "@logtape/logtape";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Disk } from "flydrive";
import type Keyv from "keyv";

const logger = getLogger(["hackerspub", "models", "admin"]);
import type { Database, Transaction } from "./db.ts";
import {
  accountTable,
  actorTable,
  adminStateTable,
  articleContentTable,
  articleDraftMediumTable,
  articleDraftTable,
  articleSourceMediumTable,
  mediumTable,
  noteSourceMediumTable,
  postTable,
} from "./schema.ts";
import { type Uuid, validateUuid } from "./uuid.ts";

// Key under which the last-regen timestamp is stored, both in the
// `admin_state` DB table (current) and historically in KV (still
// honoured as a read-side fallback for deployments that haven't run
// the regen mutation since the migration).
export const INVITATIONS_LAST_REGEN_KEY = "invitations_last_regen";

// Postgres advisory-lock key for serialising invitation regeneration
// across processes; stays distinct from other lock keys in the codebase.
const INVITATIONS_REGEN_LOCK_KEY = 0x69_6e_76_72;

export const DEFAULT_REGEN_CUTOFF_DURATION: Temporal.Duration = Temporal
  .Duration.from({ days: 7 });

export const DEFAULT_ORPHAN_MEDIA_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const ORPHAN_MEDIA_DELETE_BATCH_SIZE = 1000;
const ORPHAN_MEDIA_STORAGE_DELETE_CONCURRENCY = 8;

function isTransaction(db: Database): db is Transaction {
  return "rollback" in db;
}

export interface RegenerateInvitationsResult {
  regenerated: Date;
  accountsAffected: number;
  cutoffDate: Date;
}

export interface InvitationRegenerationStatus {
  lastRegenerated: Date | null;
  cutoffDate: Date;
  eligibleAccountsCount: number;
  topThirdCount: number;
}

export interface RegenerateOptions {
  now?: Date;
  defaultCutoffDuration?: Temporal.Duration;
}

export interface OrphanMediaStatus {
  cutoffDate: Date;
  orphanMediaCount: number;
}

export interface OrphanMediaOptions {
  now?: Date;
  gracePeriodMs?: number;
}

export interface DeleteOrphanMediaResult {
  cutoffDate: Date;
  deletedCount: number;
  failedDiskDeletes: number;
}

export async function getInvitationsLastRegen(
  db: Database,
  kv?: Keyv,
): Promise<Date | null> {
  const row = await db.query.adminStateTable.findFirst({
    where: { key: INVITATIONS_LAST_REGEN_KEY },
  });
  if (row != null) {
    const parsed = new Date(row.value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  // Fallback: a deployment that previously stored the cutoff in KV
  // still gets the right value here on its first regen call after the
  // upgrade.  The next regen writes to DB, after which this branch is
  // never taken again.
  if (kv == null) return null;
  const raw = await kv.get(INVITATIONS_LAST_REGEN_KEY);
  if (raw == null) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function resolveCutoff(
  lastRegen: Date | null,
  options: RegenerateOptions,
): { now: Date; cutoffDate: Date } {
  const now = options.now ?? new Date();
  if (lastRegen != null) return { now, cutoffDate: lastRegen };
  const duration = options.defaultCutoffDuration ??
    DEFAULT_REGEN_CUTOFF_DURATION;
  // `Temporal.Instant.subtract` rejects calendar units like days, so
  // convert the duration to milliseconds first.
  const ms = duration.total({ unit: "millisecond" });
  const cutoffDate = new Date(now.getTime() - ms);
  return { now, cutoffDate };
}

async function selectActiveAccounts(
  db: Database,
  cutoffDate: Date,
  now: Date,
): Promise<{ accountId: Uuid; postCount: number }[]> {
  const rows = await db
    .select({
      accountId: actorTable.accountId,
      postCount: count(),
    })
    .from(postTable)
    .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
    .where(
      and(
        isNotNull(actorTable.accountId),
        gt(postTable.published, cutoffDate),
        // Clamp to `now` so future-dated posts (clock-skewed
        // federation input, scheduled posts) do not award
        // invitations before they are actually published.
        lte(postTable.published, now),
      ),
    )
    .groupBy(actorTable.accountId)
    .orderBy(desc(count()), asc(actorTable.accountId));
  return rows
    .filter((row): row is typeof row & { accountId: Uuid } =>
      row.accountId != null && validateUuid(row.accountId)
    )
    .map((row) => ({
      accountId: row.accountId,
      postCount: Number(row.postCount),
    }));
}

export async function getInvitationRegenerationStatus(
  db: Database,
  kv?: Keyv,
  options: RegenerateOptions = {},
): Promise<InvitationRegenerationStatus> {
  const lastRegenerated = await getInvitationsLastRegen(db, kv);
  const { now, cutoffDate } = resolveCutoff(lastRegenerated, options);
  const active = await selectActiveAccounts(db, cutoffDate, now);
  return {
    lastRegenerated,
    cutoffDate,
    eligibleAccountsCount: active.length,
    topThirdCount: Math.ceil(active.length / 3),
  };
}

export async function regenerateInvitations(
  db: Database,
  kv?: Keyv,
  options: RegenerateOptions = {},
): Promise<RegenerateInvitationsResult> {
  // Serialise regeneration across concurrent calls and keep all
  // mutations atomic with the cutoff write.  The advisory lock holds
  // for the whole transaction; the cutoff is upserted into
  // admin_state inside the same transaction as the leftInvitations
  // updates, so commit either persists everything (rows + cutoff) or
  // nothing at all.  No race window exists between commit and a
  // separate cutoff write because there is no separate write.
  const runDbWork = async (
    tx: Transaction,
  ): Promise<RegenerateInvitationsResult> => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${INVITATIONS_REGEN_LOCK_KEY})`,
    );
    const lastRegen = await getInvitationsLastRegen(tx, kv);
    const { now, cutoffDate } = resolveCutoff(lastRegen, options);
    const active = await selectActiveAccounts(tx, cutoffDate, now);
    const topThirdCount = Math.ceil(active.length / 3);
    const topAccountIds = active.slice(0, topThirdCount).map((a) =>
      a.accountId
    );
    let accountsAffected = 0;
    if (topAccountIds.length > 0) {
      const updated = await tx
        .update(accountTable)
        .set({
          leftInvitations: sql`${accountTable.leftInvitations} + 1`,
        })
        .where(inArray(accountTable.id, topAccountIds))
        .returning({ id: accountTable.id });
      accountsAffected = updated.length;
    }
    await tx
      .insert(adminStateTable)
      .values({
        key: INVITATIONS_LAST_REGEN_KEY,
        value: now.toISOString(),
        updated: now,
      })
      .onConflictDoUpdate({
        target: adminStateTable.key,
        set: { value: now.toISOString(), updated: now },
      });
    return { regenerated: now, accountsAffected, cutoffDate };
  };
  const ranInExistingTransaction = isTransaction(db);
  const result = ranInExistingTransaction
    ? await runDbWork(db)
    : await db.transaction(runDbWork);
  // Best-effort sync to the legacy KV key so the legacy
  // /admin/invitations route (which still reads
  // INVITATIONS_LAST_REGEN_KEY from KV) sees the new cutoff during
  // the dual-stack soak.  Only run the sync when we own the
  // transaction we just committed: when the caller passed an
  // existing tx, the outer caller controls the commit/rollback
  // boundary, so syncing here would advance KV before the outer
  // transaction commits and leave KV ahead of DB if the outer
  // caller later rolls back.  The DB row remains the authoritative
  // source for the new path; if this write fails the legacy route
  // may use a stale cutoff and over-grant on its next run, which is
  // recoverable.  When the legacy route is removed the sync (and
  // the kv parameter) can go away too.
  if (kv != null && !ranInExistingTransaction) {
    try {
      await kv.set(
        INVITATIONS_LAST_REGEN_KEY,
        result.regenerated.toISOString(),
      );
    } catch (error) {
      logger.warn(
        "Failed to sync legacy KV invitation cutoff: {error}",
        { error },
      );
    }
  }
  return result;
}

function resolveOrphanMediaCutoff(options: OrphanMediaOptions): Date {
  const now = options.now ?? new Date();
  const gracePeriodMs = options.gracePeriodMs ??
    DEFAULT_ORPHAN_MEDIA_GRACE_PERIOD_MS;
  return new Date(now.getTime() - gracePeriodMs);
}

function orphanMediaWhere(cutoffDate: Date): SQL {
  const cutoffDateSql = sql`${cutoffDate.toISOString()}::timestamptz`;
  const mediumKeyPattern = sql`replace(${mediumTable.key}, '.', '[.]')`;
  const mediumReferenceBoundary = sql`'([^A-Za-z0-9._:/-]|$)'`;
  const hpMediumReferencePattern =
    sql`'hp-medium:' || ${mediumKeyPattern} || ${mediumReferenceBoundary}`;
  const directMediumReferencePattern =
    sql`'/media/' || ${mediumKeyPattern} || ${mediumReferenceBoundary}`;
  const keyPathMediumReferencePattern =
    sql`'/' || ${mediumKeyPattern} || ${mediumReferenceBoundary}`;
  return sql`
    ${mediumTable.created} < ${cutoffDateSql} AND
    NOT EXISTS (
      SELECT 1 FROM ${accountTable}
      WHERE ${accountTable.avatarMediumId} = ${mediumTable.id}
    ) AND
    NOT EXISTS (
      SELECT 1 FROM ${noteSourceMediumTable}
      WHERE ${noteSourceMediumTable.mediumId} = ${mediumTable.id}
    ) AND
    NOT EXISTS (
      SELECT 1 FROM ${articleDraftMediumTable}
      WHERE ${articleDraftMediumTable.mediumId} = ${mediumTable.id}
    ) AND
    NOT EXISTS (
      SELECT 1 FROM ${articleSourceMediumTable}
      WHERE ${articleSourceMediumTable.mediumId} = ${mediumTable.id}
    ) AND
    NOT EXISTS (
      SELECT 1 FROM ${articleDraftTable}
      WHERE
        ${articleDraftTable.content} ~ (${hpMediumReferencePattern}) OR
        ${articleDraftTable.content} ~ (${directMediumReferencePattern}) OR
        ${articleDraftTable.content} ~ (${keyPathMediumReferencePattern})
    ) AND
    NOT EXISTS (
      SELECT 1 FROM ${articleContentTable}
      WHERE
        ${articleContentTable.content} ~ (${hpMediumReferencePattern}) OR
        ${articleContentTable.content} ~ (${directMediumReferencePattern}) OR
        ${articleContentTable.content} ~ (${keyPathMediumReferencePattern})
    )
  `;
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function getOrphanMediaStatus(
  db: Database,
  options: OrphanMediaOptions = {},
): Promise<OrphanMediaStatus> {
  const cutoffDate = resolveOrphanMediaCutoff(options);
  const [row] = await db
    .select({ count: count() })
    .from(mediumTable)
    .where(orphanMediaWhere(cutoffDate));
  return {
    cutoffDate,
    orphanMediaCount: Number(row?.count ?? 0),
  };
}

export async function deleteOrphanMedia(
  db: Database,
  disk: Disk,
  options: OrphanMediaOptions = {},
): Promise<DeleteOrphanMediaResult> {
  const cutoffDate = resolveOrphanMediaCutoff(options);
  const runDeletion = async (tx: Database | Transaction) => {
    const orphanMedia = await tx
      .select({ id: mediumTable.id, key: mediumTable.key })
      .from(mediumTable)
      .where(orphanMediaWhere(cutoffDate))
      .orderBy(mediumTable.created)
      .limit(ORPHAN_MEDIA_DELETE_BATCH_SIZE)
      .for("update");
    const candidateIds = orphanMedia.map((medium) => medium.id);
    return candidateIds.length < 1 ? [] : await tx
      .delete(mediumTable)
      .where(and(
        inArray(mediumTable.id, candidateIds),
        orphanMediaWhere(cutoffDate),
      ))
      .returning({ key: mediumTable.key });
  };
  const deleted = isTransaction(db)
    ? await runDeletion(db)
    : await db.transaction(runDeletion);

  const deleteResults = await mapWithConcurrency(
    deleted,
    ORPHAN_MEDIA_STORAGE_DELETE_CONCURRENCY,
    async ({ key }) => {
      try {
        await disk.delete(key);
        return { key, deleted: true };
      } catch (error) {
        logger.warn(
          "Failed to delete orphan medium object {key}: {error}",
          { key, error },
        );
        return { key, deleted: false };
      }
    },
  );
  return {
    cutoffDate,
    deletedCount: deleted.length,
    failedDiskDeletes: deleteResults.filter((result) => !result.deleted)
      .length,
  };
}
