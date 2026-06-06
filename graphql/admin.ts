import {
  deleteOrphanMedia,
  getInvitationRegenerationStatus,
  getOrphanMediaStatus,
  type InvitationRegenerationStatus as ModelInvitationRegenerationStatus,
  regenerateInvitations,
} from "@hackerspub/models/admin";
import {
  accountTable,
  actorTable,
  followingTable,
  postTable,
} from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import {
  resolveCursorConnection,
  type ResolveCursorConnectionArgs,
} from "@pothos/plugin-relay";
import { and, asc, desc, eq, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";
import { NotAuthorizedError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

const ADMIN_SORT_FIELDS = [
  "FOLLOWING",
  "FOLLOWERS",
  "POSTS",
  "INVITATIONS_LEFT",
  "INVITED",
  "LAST_ACTIVITY",
  "CREATED",
] as const;

const AdminAccountOrderBy = builder.enumType("AdminAccountOrderBy", {
  values: ADMIN_SORT_FIELDS,
});

const OrderDirection = builder.enumType("OrderDirection", {
  values: ["ASC", "DESC"] as const,
});

type AdminOrderBy = typeof AdminAccountOrderBy.$inferType;
type AdminOrderDir = typeof OrderDirection.$inferType;

interface AdminAccountRow {
  account: typeof accountTable.$inferSelect;
  lastActivity: Date;
  // Raw string representation of the sort key value, used to encode the
  // cursor without precision loss.  For timestamp sorts this is the raw
  // PostgreSQL `timestamptz` text; for integer sorts it is the decimal
  // string representation of the count.
  sortValRaw: string;
}

interface AdminCursorData {
  field: AdminOrderBy;
  dir: AdminOrderDir;
  val: string; // raw sort-key value
  id: string; // account UUID
}

// Encoded as base64(field|dir|val|id).  None of the constituent values
// contain "|" (enum names use only [A-Z_], directions are "ASC"/"DESC",
// PostgreSQL timestamps use ":", "-", ".", "+" and spaces, integers use
// only digits, and UUIDs use hex digits and "-"), so a single "|"
// delimiter is safe.
function encodeAdminCursor(data: AdminCursorData): string {
  return btoa(`${data.field}|${data.dir}|${data.val}|${data.id}`);
}

function decodeAdminCursor(encoded: string): AdminCursorData | null {
  try {
    const decoded = atob(encoded);
    const first = decoded.indexOf("|");
    const second = decoded.indexOf("|", first + 1);
    const last = decoded.lastIndexOf("|");
    if (first < 0 || second < 0 || last <= second) return null;
    const field = decoded.slice(0, first) as AdminOrderBy;
    const dir = decoded.slice(first + 1, second) as AdminOrderDir;
    const val = decoded.slice(second + 1, last);
    const id = decoded.slice(last + 1);
    if (!(ADMIN_SORT_FIELDS as readonly string[]).includes(field)) return null;
    if (dir !== "ASC" && dir !== "DESC") return null;
    if (!validateUuid(id as Uuid)) return null;
    // Validate the sort-key value to prevent SQL cast errors.
    const isTimestampField = field === "LAST_ACTIVITY" || field === "CREATED";
    if (isTimestampField) {
      // Validate the PostgreSQL timestamptz text format emitted by ::text
      // (e.g. "2024-01-15 10:30:00.123456+00") by checking each calendar
      // and time component directly.  Avoids relying on JS Date parsing,
      // which normalises invalid dates and shifts local dates to UTC.
      // Cursors are always emitted in UTC ("+00"); reject any other offset.
      const pgTsPattern =
        /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?\+00$/;
      const pgMatch = pgTsPattern.exec(val);
      if (!pgMatch) return null;
      const [, yr, mo, dy, hh, mm, ss] = pgMatch.map(Number);
      if (yr < 1 || mo < 1 || mo > 12) return null;
      // Last day of the month (new Date(yr, mo, 0) = day 0 of next month).
      const maxDay = new Date(yr, mo, 0).getDate();
      if (dy < 1 || dy > maxDay) return null;
      if (hh > 23 || mm > 59 || ss > 59) return null;
    } else {
      // Signed decimal integer, within PostgreSQL bigint range.
      // INVITATIONS_LEFT is a signed smallint so negative cursor values
      // are possible; the leading "-" must be accepted here.
      if (!/^-?\d+$/.test(val)) return null;
      const n = BigInt(val);
      if (n < -9223372036854775808n || n > 9223372036854775807n) return null;
    }
    return { field, dir, val, id };
  } catch {
    return null;
  }
}

const AdminAccountEdge = builder.simpleObject("AdminAccountEdge", {
  fields: (t) => ({
    cursor: t.string(),
    node: t.field({ type: Account }),
    lastActivity: t.field({
      type: "DateTime",
      description:
        "The timestamp this row is sorted by: COALESCE(MAX(post.published), account.updated).  Always defined.",
    }),
  }),
});

const AdminAccountPageInfo = builder.simpleObject("AdminAccountPageInfo", {
  fields: (t) => ({
    hasNextPage: t.boolean(),
    hasPreviousPage: t.boolean(),
    startCursor: t.string({ nullable: true }),
    endCursor: t.string({ nullable: true }),
  }),
});

interface AdminAccountConnectionShape {
  totalCount: number;
  edges: {
    cursor: string;
    node: typeof accountTable.$inferSelect;
    lastActivity: Date;
  }[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
}

const AdminAccountConnection = builder.simpleObject("AdminAccountConnection", {
  fields: (t) => ({
    totalCount: t.int(),
    edges: t.field({ type: [AdminAccountEdge] }),
    pageInfo: t.field({ type: AdminAccountPageInfo }),
  }),
});

builder.queryField("adminAccounts", (t) =>
  t.field({
    type: AdminAccountConnection,
    nullable: true,
    description:
      "Moderator-only connection of every account.  Returns null when " +
      "the viewer is not a moderator; routes should guard with " +
      "`viewer.moderator` and redirect non-moderators.",
    args: {
      first: t.arg.int(),
      after: t.arg.string(),
      last: t.arg.int(),
      before: t.arg.string(),
      orderBy: t.arg({ type: AdminAccountOrderBy }),
      orderDirection: t.arg({ type: OrderDirection }),
      search: t.arg.string(),
    },
    async resolve(
      _root,
      args,
      ctx,
    ): Promise<AdminAccountConnectionShape | null> {
      if (ctx.session == null) return null;
      if (!ctx.account?.moderator) return null;

      const orderBy: AdminOrderBy = args.orderBy ?? "LAST_ACTIVITY";
      const orderDir: AdminOrderDir = args.orderDirection ?? "DESC";

      // Split the search string into words; each word must appear in either
      // the display name or the username (case-insensitive substring match).
      // "!" is used as the ILIKE escape character so "%" and "_" in the
      // search term are treated as literals rather than SQL wildcards.
      const searchWords = (args.search ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const searchFilter = searchWords.length === 0 ? undefined : and(
        ...searchWords.map((w) => {
          const p = `%${
            w.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_")
          }%`;
          return or(
            sql`${accountTable.name} ILIKE ${p} ESCAPE '!'`,
            sql`${accountTable.username} ILIKE ${p} ESCAPE '!'`,
          )!;
        }),
      );

      // --- Subqueries ---

      // Post count + latest published timestamp per account, used for
      // LAST_ACTIVITY sort and POSTS sort.
      const postsSubq = ctx.db
        .select({
          accountId: actorTable.accountId,
          count: sql<number>`COUNT(*)::int`.as("count"),
          maxPublished: sql<Date | null>`MAX(${postTable.published})`.as(
            "max_published",
          ),
        })
        .from(postTable)
        .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
        .where(isNotNull(actorTable.accountId))
        .groupBy(actorTable.accountId)
        .as("posts_agg");

      // Build only the aggregate subquery needed for the current sort field.
      // Follower / following / invitee counts are expensive GROUP BY aggregates;
      // joining all three on every request is wasteful when only one is used.
      const followersSubq = orderBy !== "FOLLOWERS" ? null : ctx.db
        .select({
          accountId: actorTable.accountId,
          count: sql<number>`COUNT(*)::int`.as("count"),
        })
        .from(followingTable)
        .innerJoin(actorTable, eq(actorTable.id, followingTable.followeeId))
        .where(
          and(
            isNotNull(actorTable.accountId),
            isNotNull(followingTable.accepted),
          ),
        )
        .groupBy(actorTable.accountId)
        .as("followers_agg");

      const followingSubq = orderBy !== "FOLLOWING" ? null : ctx.db
        .select({
          accountId: actorTable.accountId,
          count: sql<number>`COUNT(*)::int`.as("count"),
        })
        .from(followingTable)
        .innerJoin(actorTable, eq(actorTable.id, followingTable.followerId))
        .where(
          and(
            isNotNull(actorTable.accountId),
            isNotNull(followingTable.accepted),
          ),
        )
        .groupBy(actorTable.accountId)
        .as("following_agg");

      const inviteesSubq = orderBy !== "INVITED" ? null : ctx.db
        .select({
          inviterId: accountTable.inviterId,
          count: sql<number>`COUNT(*)::int`.as("count"),
        })
        .from(accountTable)
        .where(isNotNull(accountTable.inviterId))
        .groupBy(accountTable.inviterId)
        .as("invitees_agg");

      // COALESCE(MAX(post.published), account.updated) — the "last activity"
      // value used for display and for the LAST_ACTIVITY sort.
      const lastActivityExpr = sql<
        Date
      >`COALESCE(${postsSubq.maxPublished}, ${accountTable.updated})`;

      // Sort expression and cursor value extractor for the active sort field.
      // Built with a switch so references to conditional subqueries are only
      // evaluated when those subqueries are actually constructed (non-null).
      interface SortRow {
        lastActivityRaw: string;
        createdRaw: string;
        sortCount: number;
        account: typeof accountTable.$inferSelect;
      }

      let sortExpr: SQL;
      let isTimestamp: boolean;
      let extractSortVal: (r: SortRow) => string;
      switch (orderBy) {
        case "FOLLOWING":
          sortExpr = sql<number>`COALESCE(${followingSubq!.count}, 0)`;
          isTimestamp = false;
          extractSortVal = (r) => String(r.sortCount);
          break;
        case "FOLLOWERS":
          sortExpr = sql<number>`COALESCE(${followersSubq!.count}, 0)`;
          isTimestamp = false;
          extractSortVal = (r) => String(r.sortCount);
          break;
        case "POSTS":
          sortExpr = sql<number>`COALESCE(${postsSubq.count}, 0)`;
          isTimestamp = false;
          extractSortVal = (r) => String(r.sortCount);
          break;
        case "INVITATIONS_LEFT":
          sortExpr = sql`${accountTable.leftInvitations}`;
          isTimestamp = false;
          extractSortVal = (r) => String(r.account.leftInvitations);
          break;
        case "INVITED":
          sortExpr = sql<number>`COALESCE(${inviteesSubq!.count}, 0)`;
          isTimestamp = false;
          extractSortVal = (r) => String(r.sortCount);
          break;
        case "LAST_ACTIVITY":
          sortExpr = lastActivityExpr;
          isTimestamp = true;
          extractSortVal = (r) => r.lastActivityRaw;
          break;
        case "CREATED":
          sortExpr = sql`${accountTable.created}`;
          isTimestamp = true;
          extractSortVal = (r) => r.createdRaw;
          break;
      }

      const [{ totalCount }] = await ctx.db
        .select({ totalCount: sql<number>`COUNT(*)::int` })
        .from(accountTable)
        .where(searchFilter);

      // --- Cursor filter helpers ---
      // For DESC natural order: "after" a cursor means a smaller value;
      // for ASC natural order: "after" means a larger value.
      function buildAfterFilter(c: AdminCursorData): SQL {
        const cast = isTimestamp ? "timestamptz" : "bigint";
        const v = sql`${c.val}::${sql.raw(cast)}`;
        const id = sql`${c.id}::uuid`;
        return c.dir === "DESC"
          ? sql`(${sortExpr} < ${v}) OR (${sortExpr} = ${v} AND ${accountTable.id} < ${id})`
          : sql`(${sortExpr} > ${v}) OR (${sortExpr} = ${v} AND ${accountTable.id} > ${id})`;
      }

      function buildBeforeFilter(c: AdminCursorData): SQL {
        const cast = isTimestamp ? "timestamptz" : "bigint";
        const v = sql`${c.val}::${sql.raw(cast)}`;
        const id = sql`${c.id}::uuid`;
        return c.dir === "DESC"
          ? sql`(${sortExpr} > ${v}) OR (${sortExpr} = ${v} AND ${accountTable.id} > ${id})`
          : sql`(${sortExpr} < ${v}) OR (${sortExpr} = ${v} AND ${accountTable.id} < ${id})`;
      }

      const connection = await resolveCursorConnection(
        {
          args,
          toCursor: (row: AdminAccountRow) =>
            encodeAdminCursor({
              field: orderBy,
              dir: orderDir,
              val: row.sortValRaw,
              id: row.account.id,
            }),
        },
        async (
          { before, after, limit, inverted }: ResolveCursorConnectionArgs,
        ): Promise<AdminAccountRow[]> => {
          const beforeCursor = before == null
            ? null
            : decodeAdminCursor(before);
          const afterCursor = after == null ? null : decodeAdminCursor(after);

          // Reject cursors that don't match the current sort to prevent
          // wrong pagination or SQL cast errors when the sort changes.
          const validAfter = afterCursor != null &&
              afterCursor.field === orderBy &&
              afterCursor.dir === orderDir
            ? afterCursor
            : null;
          const validBefore = beforeCursor != null &&
              beforeCursor.field === orderBy &&
              beforeCursor.dir === orderDir
            ? beforeCursor
            : null;

          const afterFilter = validAfter == null
            ? undefined
            : buildAfterFilter(validAfter);
          const beforeFilter = validBefore == null
            ? undefined
            : buildBeforeFilter(validBefore);

          // `inverted` flips ORDER BY so resolveCursorConnection can fetch
          // the LAST N items closest to the cursor and then reverse them.
          const descending = (orderDir === "DESC") !== inverted;
          const orderByClause = descending
            ? [desc(sortExpr), desc(accountTable.id)]
            : [asc(sortExpr), asc(accountTable.id)];

          // sortCount carries the active sort field's count expression.
          // For timestamp and INVITATIONS_LEFT sorts it is unused (set to 0).
          const sortCountExpr: SQL<number> = isTimestamp
            ? sql<number>`0`
            : sql<number>`(${sortExpr})::int`;

          // Build the base query with postsSubq always joined (needed for
          // lastActivityExpr), then conditionally join the one optional
          // subquery the current sort field requires.
          const baseQ = ctx.db
            .select({
              account: accountTable,
              lastActivity: lastActivityExpr,
              // Format timestamps as UTC text for cursor encoding.  Using
              // AT TIME ZONE 'UTC' before to_char ensures the cursor value
              // is always "+00", regardless of the PostgreSQL session timezone.
              lastActivityRaw: sql<
                string
              >`to_char(${lastActivityExpr} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`,
              createdRaw: sql<
                string
              >`to_char(${accountTable.created} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`,
              sortCount: sortCountExpr,
            })
            .from(accountTable)
            .leftJoin(postsSubq, eq(postsSubq.accountId, accountTable.id))
            .$dynamic();

          // $dynamic() allows conditional leftJoin calls at the cost of a
          // type assertion: each leftJoin changes the nullabilityMap in the
          // return type, so we cast back to the base dynamic type.
          type DynQ = typeof baseQ;
          let q: DynQ = baseQ;
          if (followersSubq != null) {
            q = q.leftJoin(
              followersSubq,
              eq(followersSubq.accountId, accountTable.id),
            ) as unknown as DynQ;
          }
          if (followingSubq != null) {
            q = q.leftJoin(
              followingSubq,
              eq(followingSubq.accountId, accountTable.id),
            ) as unknown as DynQ;
          }
          if (inviteesSubq != null) {
            q = q.leftJoin(
              inviteesSubq,
              eq(inviteesSubq.inviterId, accountTable.id),
            ) as unknown as DynQ;
          }

          const rows = await q
            .where(and(beforeFilter, afterFilter, searchFilter))
            .orderBy(...orderByClause)
            .limit(limit);

          return rows.map((r) => {
            const lastActivityRaw = String(r.lastActivityRaw);
            const rawAct = r.lastActivity as unknown;
            const lastActivity = rawAct instanceof Date
              ? rawAct
              : new Date(rawAct as string);

            const sortValRaw = extractSortVal({
              lastActivityRaw,
              createdRaw: String(r.createdRaw),
              sortCount: r.sortCount,
              account: r.account,
            });

            return { account: r.account, lastActivity, sortValRaw };
          });
        },
      );

      return {
        totalCount,
        edges: connection.edges.map((edge) => ({
          cursor: edge.cursor,
          node: edge.node.account,
          lastActivity: edge.node.lastActivity,
        })),
        pageInfo: {
          hasNextPage: connection.pageInfo.hasNextPage,
          hasPreviousPage: connection.pageInfo.hasPreviousPage,
          startCursor: connection.pageInfo.startCursor ?? null,
          endCursor: connection.pageInfo.endCursor ?? null,
        },
      };
    },
  }));

const InvitationRegenerationStatus = builder.simpleObject(
  "InvitationRegenerationStatus",
  {
    description:
      "A snapshot of the invitation-regeneration state used by the admin UI " +
      "to preview a regeneration before triggering it.",
    fields: (t) => ({
      lastRegenerated: t.field({
        type: "DateTime",
        nullable: true,
        description:
          "When the regeneration was last triggered, or null if it has " +
          "never been run.",
      }),
      lastRegeneratedAt: t.field({
        type: "DateTime",
        nullable: true,
        deprecationReason: "Use lastRegenerated",
        description:
          "When the regeneration was last triggered, or null if it has " +
          "never been run.",
      }),
      cutoffDate: t.field({
        type: "DateTime",
        description:
          "The earliest `published` timestamp a post must have to count " +
          "an account as eligible.  Equals `lastRegenerated` once a " +
          "regeneration has been recorded; otherwise defaults to one " +
          "week before now.",
      }),
      eligibleAccountsCount: t.int({
        description: "Number of accounts with at least one post past cutoff.",
      }),
      topThirdCount: t.int({
        description:
          "Number of accounts that would receive an invitation if a " +
          "regeneration were triggered now (ceil(eligible / 3)).",
      }),
    }),
  },
);

interface InvitationRegenerationStatusShape {
  lastRegenerated: Date | null;
  lastRegeneratedAt: Date | null;
  cutoffDate: Date;
  eligibleAccountsCount: number;
  topThirdCount: number;
}

function toInvitationRegenerationStatusShape(
  status: ModelInvitationRegenerationStatus,
): InvitationRegenerationStatusShape {
  return {
    lastRegenerated: status.lastRegeneratedAt,
    lastRegeneratedAt: status.lastRegeneratedAt,
    cutoffDate: status.cutoffDate,
    eligibleAccountsCount: status.eligibleAccountsCount,
    topThirdCount: status.topThirdCount,
  };
}

builder.queryField("invitationRegenerationStatus", (t) =>
  t.field({
    type: InvitationRegenerationStatus,
    nullable: true,
    description:
      "Moderator-only invitation-regeneration preview.  Returns null " +
      "when the viewer is not a moderator; the route guards with " +
      "`viewer.moderator` to redirect non-moderators.",
    async resolve(_root, _args, ctx) {
      if (ctx.session == null) return null;
      if (!ctx.account?.moderator) return null;
      return toInvitationRegenerationStatusShape(
        await getInvitationRegenerationStatus(ctx.db, ctx.kv),
      );
    },
  }));

const RegenerateInvitationsPayload = builder.simpleObject(
  "RegenerateInvitationsPayload",
  {
    description: "The result of a successful invitations regeneration.",
    fields: (t) => ({
      regenerated: t.field({
        type: "DateTime",
        description: "When the regeneration ran.",
      }),
      regeneratedAt: t.field({
        type: "DateTime",
        deprecationReason: "Use regenerated",
        description: "When the regeneration ran.",
      }),
      accountsAffected: t.int({
        description:
          "Number of accounts whose `leftInvitations` was incremented.",
      }),
      status: t.field({
        type: InvitationRegenerationStatus,
        description:
          "The updated regeneration status reflecting the just-recorded run.",
      }),
    }),
  },
);

builder.mutationField("regenerateInvitations", (t) =>
  t.field({
    type: RegenerateInvitationsPayload,
    description:
      "Grant +1 invitation to the top third of accounts with at least " +
      "one post since the last regeneration cutoff, and persist the new " +
      "last-regen timestamp.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError],
    },
    async resolve(_root, _args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const result = await regenerateInvitations(ctx.db, ctx.kv);
      // Recompute the status against the fresh cutoff: in the common
      // case both eligibility counts are 0 because the cutoff moved
      // to "now", but federation can deliver posts whose `published`
      // is in the future relative to the regenerator's clock, and
      // those still count as eligible after regen.  Hardcoding zeros
      // would silently mislead clients that watch this payload, so
      // pay one aggregate query and report the actual numbers.
      const status = await getInvitationRegenerationStatus(ctx.db, ctx.kv);
      return {
        regenerated: result.regeneratedAt,
        regeneratedAt: result.regeneratedAt,
        accountsAffected: result.accountsAffected,
        status: toInvitationRegenerationStatusShape(status),
      };
    },
  }));

const OrphanMediaStatus = builder.simpleObject(
  "OrphanMediaStatus",
  {
    description:
      "A snapshot of media objects old enough to delete and not referenced " +
      "by accounts, notes, article drafts, or article sources.",
    fields: (t) => ({
      cutoffDate: t.field({
        type: "DateTime",
        description:
          "Only unreferenced media created before this timestamp are counted.",
      }),
      orphanMediaCount: t.int({
        description:
          "Number of unreferenced media objects older than the cutoff.",
      }),
    }),
  },
);

builder.queryField("orphanMediaStatus", (t) =>
  t.field({
    type: OrphanMediaStatus,
    nullable: true,
    description:
      "Moderator-only orphan media preview.  Returns null when the viewer " +
      "is not a moderator.",
    async resolve(_root, _args, ctx) {
      if (ctx.session == null) return null;
      if (!ctx.account?.moderator) return null;
      return await getOrphanMediaStatus(ctx.db);
    },
  }));

const DeleteOrphanMediaPayload = builder.simpleObject(
  "DeleteOrphanMediaPayload",
  {
    description: "The result of deleting orphan media.",
    fields: (t) => ({
      deletedCount: t.int({
        description: "Number of orphan media database rows deleted.",
      }),
      failedStorageDeletes: t.int({
        description:
          "Number of stored media objects that could not be deleted.",
      }),
      status: t.field({
        type: OrphanMediaStatus,
        description: "The orphan media status after the deletion attempt.",
      }),
    }),
  },
);

builder.mutationField("deleteOrphanMedia", (t) =>
  t.field({
    type: DeleteOrphanMediaPayload,
    description:
      "Delete unreferenced media older than the grace period.  Requires a " +
      "moderator account.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError],
    },
    async resolve(_root, _args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const result = await deleteOrphanMedia(ctx.db, ctx.disk);
      const status = await getOrphanMediaStatus(ctx.db);
      return {
        deletedCount: result.deletedCount,
        failedStorageDeletes: result.failedDiskDeletes,
        status,
      };
    },
  }));
