import {
  getInvitationRegenerationStatus,
  type InvitationRegenerationStatus as ModelInvitationRegenerationStatus,
  regenerateInvitations,
} from "@hackerspub/models/admin";
import { accountTable, actorTable, postTable } from "@hackerspub/models/schema";
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
  inArray,
  isNotNull,
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

interface AdminAccountRow {
  account: typeof accountTable.$inferSelect;
  lastActivity: Date;
  // The raw `timestamptz` text from PostgreSQL, preserving microsecond
  // precision.  We carry it alongside the JS Date so the cursor round-
  // trips bit-for-bit; a JS Date only keeps milliseconds and would
  // truncate the boundary timestamp, causing rows in the rounded
  // microsecond window to be skipped on the next page.
  lastActivityRaw: string;
}

function encodeAdminCursor(row: AdminAccountRow): string {
  return `${row.lastActivityRaw}|${row.account.id}`;
}

function decodeAdminCursor(
  cursor: string,
): { lastActivityRaw: string; accountId: Uuid } | null {
  const sep = cursor.indexOf("|");
  if (sep < 0) return null;
  const lastActivityRaw = cursor.slice(0, sep);
  const rawId = cursor.slice(sep + 1);
  // Validate by attempting to parse to a Date.  Microsecond precision
  // is lost in JS but the raw string is what gets passed back to
  // PostgreSQL via `::timestamptz`, where full precision is preserved.
  if (Number.isNaN(new Date(lastActivityRaw).getTime())) return null;
  if (!validateUuid(rawId)) return null;
  return { lastActivityRaw, accountId: rawId };
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
      "Moderator-only connection of every account, ordered by latest " +
      "post `published` falling back to `account.updated`.  Returns " +
      "null when the viewer is not a moderator; routes should guard " +
      "with `viewer.moderator` and redirect non-moderators.",
    args: {
      first: t.arg.int(),
      after: t.arg.string(),
      last: t.arg.int(),
      before: t.arg.string(),
    },
    async resolve(
      _root,
      args,
      ctx,
    ): Promise<AdminAccountConnectionShape | null> {
      if (ctx.session == null) return null;
      if (!ctx.account?.moderator) return null;

      // Aggregate the latest published timestamp per account so the
      // outer query can sort by COALESCE(MAX(published), updated).
      const lastPublishedSubquery = ctx.db
        .select({
          accountId: actorTable.accountId,
          maxPublished: sql<Date | null>`MAX(${postTable.published})`.as(
            "max_published",
          ),
        })
        .from(postTable)
        .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
        .where(isNotNull(actorTable.accountId))
        .groupBy(actorTable.accountId)
        .as("last_published");

      const lastActivityExpr = sql<
        Date
      >`COALESCE(${lastPublishedSubquery.maxPublished}, ${accountTable.updated})`;

      const totalCount = await ctx.db.$count(accountTable);

      // For the natural ordering `lastActivity DESC, accountId DESC`,
      // the cursor filters depend only on the cursor side, never on
      // `inverted`: rows BEFORE the cursor in natural order have a
      // strictly larger (lastActivity, id) tuple, and rows AFTER have a
      // strictly smaller one.  The `inverted` flag only flips the
      // ORDER BY direction so the framework can take the LAST N nodes
      // closest to the cursor and reverse them back into natural order.
      // The cursor timestamp and id are bound as text and cast inside
      // the SQL so postgres-js can serialise them (it has no parameter
      // type for the COALESCE expression).
      function tupleLessThan(tsRaw: string, id: string): SQL {
        const tsLit = sql`${tsRaw}::timestamptz`;
        const idLit = sql`${id}::uuid`;
        return sql`(${lastActivityExpr} < ${tsLit}) OR (${lastActivityExpr} = ${tsLit} AND ${accountTable.id} < ${idLit})`;
      }

      function tupleGreaterThan(tsRaw: string, id: string): SQL {
        const tsLit = sql`${tsRaw}::timestamptz`;
        const idLit = sql`${id}::uuid`;
        return sql`(${lastActivityExpr} > ${tsLit}) OR (${lastActivityExpr} = ${tsLit} AND ${accountTable.id} > ${idLit})`;
      }

      const connection = await resolveCursorConnection(
        {
          args,
          toCursor: (row: AdminAccountRow) => encodeAdminCursor(row),
        },
        async (
          { before, after, limit, inverted }: ResolveCursorConnectionArgs,
        ): Promise<AdminAccountRow[]> => {
          const beforeCursor = before == null
            ? null
            : decodeAdminCursor(before);
          const afterCursor = after == null ? null : decodeAdminCursor(after);

          const beforeFilter = beforeCursor == null
            ? undefined
            : tupleGreaterThan(
              beforeCursor.lastActivityRaw,
              beforeCursor.accountId,
            );
          const afterFilter = afterCursor == null ? undefined : tupleLessThan(
            afterCursor.lastActivityRaw,
            afterCursor.accountId,
          );

          const rows = await ctx.db
            .select({
              account: accountTable,
              lastActivity: lastActivityExpr.as("last_activity"),
            })
            .from(accountTable)
            .leftJoin(
              lastPublishedSubquery,
              eq(lastPublishedSubquery.accountId, accountTable.id),
            )
            .where(and(beforeFilter, afterFilter))
            .orderBy(
              inverted ? asc(lastActivityExpr) : desc(lastActivityExpr),
              inverted ? asc(accountTable.id) : desc(accountTable.id),
            )
            .limit(limit);

          return rows.map((r) => {
            const raw = r.lastActivity as unknown as Date | string;
            // postgres-js parses `timestamptz` columns to JS Dates by
            // default (millisecond precision), but the bare COALESCE
            // expression doesn't carry a column type, so it comes
            // through as the raw `YYYY-MM-DD HH:MM:SS.UUUUUU+00`
            // string (microsecond precision).  Keep both: the string
            // for the cursor (so boundaries round-trip exactly) and a
            // Date for the GraphQL output.
            const lastActivityRaw = raw instanceof Date
              ? raw.toISOString()
              : raw;
            const lastActivity = raw instanceof Date
              ? raw
              : new Date(raw as string);
            return {
              account: r.account,
              lastActivity,
              lastActivityRaw,
            };
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
  cutoffDate: Date;
  eligibleAccountsCount: number;
  topThirdCount: number;
}

function toInvitationRegenerationStatusShape(
  status: ModelInvitationRegenerationStatus,
): InvitationRegenerationStatusShape {
  return {
    lastRegenerated: status.lastRegeneratedAt,
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
        accountsAffected: result.accountsAffected,
        status: toInvitationRegenerationStatusShape(status),
      };
    },
  }));
