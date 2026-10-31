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
  lt,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Disk } from "flydrive";
import type Keyv from "keyv";

const logger = getLogger(["hackerspub", "models", "admin"]);
import type { Database, Transaction } from "./db.ts";
import {
  createInvitationGrantedNotification,
  sendNotificationPush,
} from "./notification.ts";
import {
  accountTable,
  actorTable,
  adminStateTable,
  articleContentTable,
  articleDraftMediumTable,
  articleDraftTable,
  articleSourceMediumTable,
  articleTranslationDraftMediumTable,
  articleTranslationDraftTable,
  type InvitationDistribution,
  invitationDistributionTable,
  mediumTable,
  noteSourceMediumTable,
  postTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid, validateUuid } from "./uuid.ts";

// Key under which the last-regen timestamp is stored, both in the
// `admin_state` DB table (current) and historically in KV (still
// honoured as a read-side fallback for deployments that haven't run
// the regen mutation since the migration).
export const INVITATIONS_LAST_REGEN_KEY = "invitations_last_regen";

// Postgres advisory-lock key for serialising invitation regeneration
// across processes; stays distinct from other lock keys in the codebase.
const INVITATIONS_REGEN_LOCK_KEY = 0x69_6e_76_72;

export const DEFAULT_REGEN_CUTOFF_DURATION: Temporal.Duration =
  Temporal.Duration.from({ days: 7 });

export const INVITATIONS_AUTO_DISTRIBUTION_KEY =
  "invitations_auto_distribution_enabled";

export const MAX_INVITATION_GRANT = 10_000;
export const MAX_INVITATION_BALANCE = 2_147_483_647;
export const MAX_INVITATION_NOTE_LENGTH = 500;

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
  periodEnd: Date;
  distribution: InvitationDistribution | null;
  skipped: boolean;
  skipReason: "duplicate" | "superseded" | null;
}

export interface InvitationRegenerationStatus {
  lastRegenerated: Date | null;
  cutoffDate: Date;
  eligibleAccountsCount: number;
  topThirdCount: number;
  autoDistributionEnabled: boolean;
}

export interface RegenerateOptions {
  now?: Date;
  defaultCutoffDuration?: Temporal.Duration;
}

export interface RegenerateInvitationsOptions extends RegenerateOptions {
  source?: "scheduled" | "manual";
  actorId?: Uuid;
  runKey?: string;
}

export interface GrantInvitationsOptions {
  accountId: Uuid;
  actorId: Uuid;
  amount: number;
  note?: string;
  now?: Date;
}

export interface GrantInvitationsResult {
  account: typeof accountTable.$inferSelect;
  granted: number;
  previousBalance: number;
  newBalance: number;
  distribution: InvitationDistribution;
}

export interface InvitationDistributionEdge {
  cursor: string;
  distribution: InvitationDistribution;
}

export interface InvitationDistributionPage {
  edges: InvitationDistributionEdge[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
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

export async function getInvitationAutoDistributionEnabled(
  db: Database | Transaction,
): Promise<boolean> {
  const row = await db.query.adminStateTable.findFirst({
    where: { key: INVITATIONS_AUTO_DISTRIBUTION_KEY },
  });
  return row == null || row.value !== "false";
}

export async function setInvitationAutoDistributionEnabled(
  db: Database | Transaction,
  enabled: boolean,
  now = new Date(),
): Promise<boolean> {
  await db
    .insert(adminStateTable)
    .values({
      key: INVITATIONS_AUTO_DISTRIBUTION_KEY,
      value: enabled ? "true" : "false",
      updated: now,
    })
    .onConflictDoUpdate({
      target: adminStateTable.key,
      set: { value: enabled ? "true" : "false", updated: now },
    });
  return enabled;
}

function resolveCutoff(
  lastRegen: Date | null,
  options: RegenerateOptions,
): { now: Date; cutoffDate: Date } {
  const now = options.now ?? new Date();
  if (lastRegen != null) return { now, cutoffDate: lastRegen };
  const duration =
    options.defaultCutoffDuration ?? DEFAULT_REGEN_CUTOFF_DURATION;
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
    .filter(
      (row): row is typeof row & { accountId: Uuid } =>
        row.accountId != null && validateUuid(row.accountId),
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
    autoDistributionEnabled: await getInvitationAutoDistributionEnabled(db),
  };
}

export async function regenerateInvitations(
  db: Database,
  kv?: Keyv,
  options: RegenerateInvitationsOptions = {},
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

    // A durable task can be retried after it has already committed.  The
    // ledger row is the idempotency record for that tick, so return it
    // instead of awarding a second time.
    if (options.runKey != null) {
      const existing = await tx.query.invitationDistributionTable.findFirst({
        where: { runKey: options.runKey },
      });
      if (existing != null) {
        if (
          existing.kind === "grant" ||
          existing.periodEnd == null ||
          existing.cutoffDate == null
        ) {
          throw new Error(
            `Invalid invitation distribution row for run key ${options.runKey}.`,
          );
        }
        return {
          regenerated: existing.periodEnd,
          accountsAffected: existing.accountsAffected,
          cutoffDate: existing.cutoffDate,
          periodEnd: existing.periodEnd,
          distribution: existing,
          skipped: true,
          skipReason: "duplicate",
        };
      }
    }

    const now = options.now ?? new Date();
    // A delayed tick must never move the cutoff backward.  This can happen
    // when a manual run (or a later tick) already covered the window while
    // this durable task was queued.
    if (lastRegen != null && now.getTime() <= lastRegen.getTime()) {
      return {
        regenerated: lastRegen,
        accountsAffected: 0,
        cutoffDate: lastRegen,
        periodEnd: lastRegen,
        distribution: null,
        skipped: true,
        skipReason: "superseded",
      };
    }

    const { cutoffDate } = resolveCutoff(lastRegen, { ...options, now });
    const active = await selectActiveAccounts(tx, cutoffDate, now);
    const topThirdCount = Math.ceil(active.length / 3);
    const topAccountIds = active
      .slice(0, topThirdCount)
      .map((a) => a.accountId);

    let accountsAffected = 0;
    const notifyAccountIds: Uuid[] = [];
    if (topAccountIds.length > 0) {
      const updated = await tx
        .update(accountTable)
        .set({
          leftInvitations: sql`${accountTable.leftInvitations} + 1`,
        })
        .where(
          and(
            inArray(accountTable.id, topAccountIds),
            lt(accountTable.leftInvitations, MAX_INVITATION_BALANCE),
          ),
        )
        .returning({
          id: accountTable.id,
          leftInvitations: accountTable.leftInvitations,
        });
      accountsAffected = updated.length;
      // Use the post-update balance rather than a separate pre-read: a
      // concurrent spend between the read and this update must not suppress
      // the notification for a row that transitions from 0 to 1.
      for (const row of updated) {
        if (row.leftInvitations === 1) notifyAccountIds.push(row.id);
      }
    }

    const actorUsername =
      options.actorId == null
        ? null
        : ((
            await tx.query.accountTable.findFirst({
              where: { id: options.actorId },
              columns: { username: true },
            })
          )?.username ?? null);
    const [distribution] = await tx
      .insert(invitationDistributionTable)
      .values({
        id: generateUuidV7(),
        kind: options.source ?? "manual",
        actorId: options.actorId ?? null,
        actorUsername,
        amount: accountsAffected,
        accountsAffected,
        eligibleAccountsCount: active.length,
        topThirdCount,
        cutoffDate,
        periodEnd: now,
        runKey: options.runKey ?? null,
        created: sql`clock_timestamp()`,
      })
      .returning();
    if (distribution == null) {
      throw new Error("Failed to record the invitation distribution.");
    }

    for (const accountId of notifyAccountIds) {
      await createInvitationGrantedNotification(
        tx,
        accountId,
        distribution.id,
        null,
        1,
      );
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
    return {
      regenerated: now,
      accountsAffected,
      cutoffDate,
      periodEnd: now,
      distribution,
      skipped: false,
      skipReason: null,
    };
  };
  return isTransaction(db)
    ? await runDbWork(db)
    : await db.transaction(runDbWork);
}

export async function grantInvitations(
  db: Database,
  options: GrantInvitationsOptions,
): Promise<GrantInvitationsResult | null> {
  if (
    !Number.isSafeInteger(options.amount) ||
    options.amount < 1 ||
    options.amount > MAX_INVITATION_GRANT
  ) {
    throw new RangeError("INVALID_AMOUNT");
  }
  const note = options.note?.trim() ?? "";
  if (note.length > MAX_INVITATION_NOTE_LENGTH) {
    throw new RangeError("INVALID_NOTE");
  }

  const committedPushes: Array<{
    accountId: Uuid;
    notificationId: Uuid;
    actorId: Uuid;
  }> = [];
  const runDbWork = async (
    tx: Transaction,
  ): Promise<GrantInvitationsResult | null> => {
    const [target] = await tx
      .select()
      .from(accountTable)
      .where(eq(accountTable.id, options.accountId))
      .for("update");
    if (target == null) return null;
    const previousBalance = target.leftInvitations;
    if (previousBalance + options.amount > MAX_INVITATION_BALANCE) {
      throw new RangeError("INVITATION_BALANCE_OVERFLOW");
    }
    const actorActor =
      previousBalance === 0
        ? await tx.query.actorTable.findFirst({
            where: { accountId: options.actorId },
            columns: { id: true },
          })
        : null;
    if (previousBalance === 0 && actorActor == null) {
      throw new Error(
        `Moderator account ${options.actorId} has no actor row for the grant notification.`,
      );
    }

    const [updated] = await tx
      .update(accountTable)
      .set({
        leftInvitations: sql`${accountTable.leftInvitations} + ${options.amount}`,
      })
      .where(eq(accountTable.id, target.id))
      .returning();
    if (updated == null) {
      throw new Error(`Failed to grant invitations to account ${target.id}.`);
    }

    const actor = await tx.query.accountTable.findFirst({
      where: { id: options.actorId },
      columns: { username: true },
    });
    const [distribution] = await tx
      .insert(invitationDistributionTable)
      .values({
        id: generateUuidV7(),
        kind: "grant",
        actorId: options.actorId,
        actorUsername: actor?.username ?? null,
        targetId: target.id,
        targetUsername: target.username,
        amount: options.amount,
        accountsAffected: 1,
        note: note === "" ? null : note,
        created: options.now ?? sql`clock_timestamp()`,
      })
      .returning();
    if (distribution == null) {
      throw new Error("Failed to record the invitation grant.");
    }

    if (previousBalance === 0 && actorActor != null) {
      const notification = await createInvitationGrantedNotification(
        tx,
        target.id,
        distribution.id,
        actorActor.id,
        options.amount,
      );
      if (notification != null) {
        committedPushes.push({
          accountId: target.id,
          notificationId: notification.id,
          actorId: actorActor.id,
        });
      }
    }

    return {
      account: updated,
      granted: options.amount,
      previousBalance,
      newBalance: updated.leftInvitations,
      distribution,
    };
  };
  const result = isTransaction(db)
    ? await runDbWork(db)
    : await db.transaction(runDbWork);
  if (result != null && !isTransaction(db)) {
    for (const push of committedPushes) {
      await sendNotificationPush(db, {
        accountId: push.accountId,
        notificationId: push.notificationId,
        type: "invitation_granted",
        actorId: push.actorId,
      });
    }
  }
  return result;
}

interface InvitationDistributionCursor {
  created: string;
  id: Uuid;
}

function encodeInvitationDistributionCursor(
  cursor: InvitationDistributionCursor,
): string {
  return btoa(`${cursor.created}|${cursor.id}`);
}

function decodeInvitationDistributionCursor(
  encoded: string,
): InvitationDistributionCursor | null {
  try {
    const decoded = atob(encoded);
    const separator = decoded.lastIndexOf("|");
    if (separator < 0) return null;
    const created = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!validateUuid(id as Uuid)) return null;
    const match =
      /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d{1,6}\+00$/.exec(
        created,
      );
    if (match == null) return null;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (year < 1 || month < 1 || month > 12) return null;
    if (day < 1 || day > maxDay) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    return { created, id: id as Uuid };
  } catch {
    return null;
  }
}

export async function getInvitationDistributions(
  db: Database,
  options: { first?: number; after?: string } = {},
): Promise<InvitationDistributionPage> {
  const first = Math.min(Math.max(options.first ?? 20, 1), 100);
  const after =
    options.after == null
      ? null
      : decodeInvitationDistributionCursor(options.after);
  const createdRaw = sql<string>`to_char(${invitationDistributionTable.created} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`;
  const rows = await db
    .select({
      distribution: invitationDistributionTable,
      createdRaw,
    })
    .from(invitationDistributionTable)
    .where(
      after == null
        ? undefined
        : sql`
          ${invitationDistributionTable.created} < ${after.created}::timestamptz
          OR (
            ${invitationDistributionTable.created} = ${after.created}::timestamptz
            AND ${invitationDistributionTable.id} < ${after.id}
          )
        `,
    )
    .orderBy(
      desc(invitationDistributionTable.created),
      desc(invitationDistributionTable.id),
    )
    .limit(first + 1);
  const hasNextPage = rows.length > first;
  const page = rows.slice(0, first);
  const edges = page.map((row) => ({
    cursor: encodeInvitationDistributionCursor({
      created: String(row.createdRaw),
      id: row.distribution.id,
    }),
    distribution: row.distribution,
  }));
  return {
    edges,
    hasNextPage,
    hasPreviousPage: after != null,
    startCursor: edges[0]?.cursor ?? null,
    endCursor: edges.at(-1)?.cursor ?? null,
  };
}

function resolveOrphanMediaCutoff(options: OrphanMediaOptions): Date {
  const now = options.now ?? new Date();
  const gracePeriodMs =
    options.gracePeriodMs ?? DEFAULT_ORPHAN_MEDIA_GRACE_PERIOD_MS;
  return new Date(now.getTime() - gracePeriodMs);
}

function orphanMediaWhere(cutoffDate: Date): SQL {
  const cutoffDateSql = sql`${cutoffDate.toISOString()}::timestamptz`;
  const mediumKeyPattern = sql`replace(${mediumTable.key}, '.', '[.]')`;
  const mediumReferenceBoundary = sql`'([^A-Za-z0-9._:/-]|$)'`;
  const hpMediumReferencePattern = sql`'hp-medium:' || ${mediumKeyPattern} || ${mediumReferenceBoundary}`;
  const directMediumReferencePattern = sql`'/media/' || ${mediumKeyPattern} || ${mediumReferenceBoundary}`;
  const keyPathMediumReferencePattern = sql`'/' || ${mediumKeyPattern} || ${mediumReferenceBoundary}`;
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
      SELECT 1 FROM ${articleTranslationDraftMediumTable}
      WHERE ${articleTranslationDraftMediumTable.mediumId} = ${mediumTable.id}
    ) AND
    NOT EXISTS (
      SELECT 1 FROM ${articleDraftTable}
      WHERE
        ${articleDraftTable.content} ~ (${hpMediumReferencePattern}) OR
        ${articleDraftTable.content} ~ (${directMediumReferencePattern}) OR
        ${articleDraftTable.content} ~ (${keyPathMediumReferencePattern})
    ) AND
    NOT EXISTS (
      SELECT 1 FROM ${articleTranslationDraftTable}
      WHERE
        ${articleTranslationDraftTable.content} ~ (${hpMediumReferencePattern}) OR
        ${articleTranslationDraftTable.content} ~ (${directMediumReferencePattern}) OR
        ${articleTranslationDraftTable.content} ~ (${keyPathMediumReferencePattern})
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
  const results = Array.from({ length: items.length }, () => undefined as U);
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
    return candidateIds.length < 1
      ? []
      : await tx
          .delete(mediumTable)
          .where(
            and(
              inArray(mediumTable.id, candidateIds),
              orphanMediaWhere(cutoffDate),
            ),
          )
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
        logger.warn("Failed to delete orphan medium object {key}: {error}", {
          key,
          error,
        });
        return { key, deleted: false };
      }
    },
  );
  return {
    cutoffDate,
    deletedCount: deleted.length,
    failedDiskDeletes: deleteResults.filter((result) => !result.deleted).length,
  };
}
