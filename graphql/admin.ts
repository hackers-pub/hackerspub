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
import DataLoader from "dataloader";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Account } from "./account.ts";
import {
  type AdminAccountStats,
  builder,
  type UserContext,
} from "./builder.ts";
import { NotAuthorizedError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

// Per-request batching loader for the moderator-only `Account.postCount`
// and `Account.lastPostPublished` aggregates.  Without this, requesting
// these fields on a 50-row connection would fan out to 100 separate
// aggregate queries.
export function getAdminAccountStats(
  ctx: UserContext,
  accountId: Uuid,
): Promise<AdminAccountStats> {
  ctx.adminAccountStatsLoader ??= new DataLoader<Uuid, AdminAccountStats>(
    async (ids) => {
      const idList = ids as Uuid[];
      const rows = await ctx.db
        .select({
          accountId: actorTable.accountId,
          postCount: sql<number>`COUNT(*)::int`,
          lastPublished: sql<Date | null>`MAX(${postTable.published})`,
        })
        .from(postTable)
        .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
        .where(
          and(
            isNotNull(actorTable.accountId),
            inArray(actorTable.accountId, idList),
          ),
        )
        .groupBy(actorTable.accountId);
      const map = new Map<string, AdminAccountStats>();
      for (const row of rows) {
        if (row.accountId == null) continue;
        const raw = row.lastPublished;
        const lastPostPublished = raw == null
          ? null
          : raw instanceof Date
          ? raw
          : new Date(raw as unknown as string);
        map.set(row.accountId, {
          postCount: Number(row.postCount),
          lastPostPublished,
        });
      }
      return idList.map((id) =>
        map.get(id) ?? { postCount: 0, lastPostPublished: null }
      );
    },
    // Per-request memoisation is on (the loader instance lives on
    // UserContext, so its cache only spans one request).  None of the
    // mutations exposed by this stack mutate postTable, so two reads
    // of the same account.id within one request never observe a
    // changed value; if a post-mutating mutation is added later this
    // loader will need its cache cleared after the mutation runs.
    { cache: true },
  );
  return ctx.adminAccountStatsLoader.load(accountId);
}

// Attach the moderator-only post aggregates to the Account type from
// here, where the loader lives.  Defining these as drizzleObjectField
// calls in admin.ts (rather than as fields on the Account.drizzleNode
// definition in account.ts) keeps the import graph one-way:
// admin.ts → account.ts only, never the reverse.
builder.drizzleObjectField(Account, "postCount", (t) =>
  t.int({
    nullable: true,
    description:
      "The total number of posts authored by this account.  Visible only to moderators; null otherwise.",
    authScopes: { moderator: true },
    async resolve(account, _, ctx) {
      const stats = await getAdminAccountStats(ctx, account.id);
      return stats.postCount;
    },
  }));

builder.drizzleObjectField(Account, "lastPostPublished", (t) =>
  t.field({
    type: "DateTime",
    nullable: true,
    description:
      "The latest `published` timestamp across all posts authored by this account, or null when there are no posts.  Visible only to moderators.",
    authScopes: { moderator: true },
    async resolve(account, _, ctx) {
      const stats = await getAdminAccountStats(ctx, account.id);
      return stats.lastPostPublished;
    },
  }));

const AdminAccountOrderBy = builder.enumType("AdminAccountOrderBy", {
  values: [
    "FOLLOWING",
    "FOLLOWERS",
    "POSTS",
    "INVITATIONS_LEFT",
    "INVITED",
    "LAST_ACTIVITY",
    "CREATED",
  ] as const,
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
    const validFields: AdminOrderBy[] = [
      "FOLLOWING",
      "FOLLOWERS",
      "POSTS",
      "INVITATIONS_LEFT",
      "INVITED",
      "LAST_ACTIVITY",
      "CREATED",
    ];
    if (!validFields.includes(field)) return null;
    if (dir !== "ASC" && dir !== "DESC") return null;
    if (!validateUuid(id as Uuid)) return null;
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
      const searchWords = (args.search ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const searchFilter = searchWords.length === 0 ? undefined : and(
        ...searchWords.map((w) =>
          or(
            ilike(accountTable.name, `%${w}%`),
            ilike(accountTable.username, `%${w}%`),
          )!
        ),
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

      // Followers per account (actors whose followeeId maps to this account).
      const followersSubq = ctx.db
        .select({
          accountId: actorTable.accountId,
          count: sql<number>`COUNT(*)::int`.as("count"),
        })
        .from(followingTable)
        .innerJoin(actorTable, eq(actorTable.id, followingTable.followeeId))
        .where(isNotNull(actorTable.accountId))
        .groupBy(actorTable.accountId)
        .as("followers_agg");

      // Following per account (actors whose followerId maps to this account).
      const followingSubq = ctx.db
        .select({
          accountId: actorTable.accountId,
          count: sql<number>`COUNT(*)::int`.as("count"),
        })
        .from(followingTable)
        .innerJoin(actorTable, eq(actorTable.id, followingTable.followerId))
        .where(isNotNull(actorTable.accountId))
        .groupBy(actorTable.accountId)
        .as("following_agg");

      // Invitees per account (accounts whose inviterId is this account).
      const inviteesSubq = ctx.db
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

      // --- Sort expression for the chosen field ---
      const sortExpr: SQL = orderBy === "FOLLOWING"
        ? sql<number>`COALESCE(${followingSubq.count}, 0)`
        : orderBy === "FOLLOWERS"
        ? sql<number>`COALESCE(${followersSubq.count}, 0)`
        : orderBy === "POSTS"
        ? sql<number>`COALESCE(${postsSubq.count}, 0)`
        : orderBy === "INVITATIONS_LEFT"
        ? sql`${accountTable.leftInvitations}`
        : orderBy === "INVITED"
        ? sql<number>`COALESCE(${inviteesSubq.count}, 0)`
        : orderBy === "CREATED"
        ? sql`${accountTable.created}`
        : lastActivityExpr; // LAST_ACTIVITY (default)

      // Timestamps need `::timestamptz` casts in cursor comparisons;
      // integer fields use `::bigint`.
      const isTimestamp = orderBy === "LAST_ACTIVITY" ||
        orderBy === "CREATED";

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

          const afterFilter = afterCursor == null
            ? undefined
            : buildAfterFilter(afterCursor);
          const beforeFilter = beforeCursor == null
            ? undefined
            : buildBeforeFilter(beforeCursor);

          // `inverted` flips ORDER BY so resolveCursorConnection can fetch
          // the LAST N items closest to the cursor and then reverse them.
          const descending = (orderDir === "DESC") !== inverted;
          const orderByClause = descending
            ? [desc(sortExpr), desc(accountTable.id)]
            : [asc(sortExpr), asc(accountTable.id)];

          const rows = await ctx.db
            .select({
              account: accountTable,
              lastActivity: lastActivityExpr,
              // Cast the COALESCE expression to text so postgres-js gives us
              // the raw microsecond-precision string needed for the cursor.
              lastActivityRaw: sql<string>`${lastActivityExpr}::text`,
              followingCount: sql<
                number
              >`COALESCE(${followingSubq.count}, 0)::int`,
              followersCount: sql<
                number
              >`COALESCE(${followersSubq.count}, 0)::int`,
              postsCount: sql<number>`COALESCE(${postsSubq.count}, 0)::int`,
              inviteesCount: sql<
                number
              >`COALESCE(${inviteesSubq.count}, 0)::int`,
            })
            .from(accountTable)
            .leftJoin(postsSubq, eq(postsSubq.accountId, accountTable.id))
            .leftJoin(
              followersSubq,
              eq(followersSubq.accountId, accountTable.id),
            )
            .leftJoin(
              followingSubq,
              eq(followingSubq.accountId, accountTable.id),
            )
            .leftJoin(
              inviteesSubq,
              sql`${inviteesSubq.inviterId} = ${accountTable.id}`,
            )
            .where(and(beforeFilter, afterFilter, searchFilter))
            .orderBy(...orderByClause)
            .limit(limit);

          return rows.map((r) => {
            // The COALESCE expression comes through as a raw string from
            // postgres-js (no column type annotation on the expression).
            const rawStr = r.lastActivityRaw as unknown;
            const lastActivityRaw = rawStr instanceof Date
              ? rawStr.toISOString()
              : String(rawStr);
            const rawAct = r.lastActivity as unknown;
            const lastActivity = rawAct instanceof Date
              ? rawAct
              : new Date(rawAct as string);

            const sortValRaw: string = orderBy === "LAST_ACTIVITY"
              ? lastActivityRaw
              : orderBy === "CREATED"
              ? (r.account.created instanceof Date
                ? r.account.created.toISOString()
                : String(r.account.created))
              : orderBy === "INVITATIONS_LEFT"
              ? String(r.account.leftInvitations)
              : orderBy === "FOLLOWING"
              ? String(r.followingCount)
              : orderBy === "FOLLOWERS"
              ? String(r.followersCount)
              : orderBy === "POSTS"
              ? String(r.postsCount)
              : String(r.inviteesCount); // INVITED

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
