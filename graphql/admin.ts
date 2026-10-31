import {
  deleteOrphanMedia,
  getInvitationDistributions,
  getInvitationRegenerationStatus,
  getOrphanMediaStatus,
  grantInvitations,
  type InvitationRegenerationStatus as ModelInvitationRegenerationStatus,
  MAX_INVITATION_GRANT,
  MAX_INVITATION_NOTE_LENGTH,
  regenerateInvitations,
  setInvitationAutoDistributionEnabled,
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
import { InvalidInputError, NotAuthorizedError } from "./error.ts";
import { AccountKind } from "./organization.ts";
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
type AccountKindFilter = typeof AccountKind.$inferType;

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
    const timestampField = field === "LAST_ACTIVITY" || field === "CREATED";
    if (timestampField) {
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
      kind: t.arg({
        type: AccountKind,
        description:
          "Optional account-kind filter. Use `PERSONAL` for login-capable " +
          "accounts and `ORGANIZATION` for organization accounts.",
      }),
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
      const accountKind: AccountKindFilter | null = args.kind ?? null;

      // Split the search string into words; each word must appear in either
      // the display name or the username (case-insensitive substring match).
      // "!" is used as the ILIKE escape character so "%" and "_" in the
      // search term are treated as literals rather than SQL wildcards.
      const searchWords = (args.search ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const searchFilter =
        searchWords.length === 0
          ? undefined
          : and(
              ...searchWords.map((w) => {
                const p = `%${w
                  .replace(/!/g, "!!")
                  .replace(/%/g, "!%")
                  .replace(/_/g, "!_")}%`;
                return or(
                  sql`${accountTable.name} ILIKE ${p} ESCAPE '!'`,
                  sql`${accountTable.username} ILIKE ${p} ESCAPE '!'`,
                )!;
              }),
            );
      const kindFilter =
        accountKind == null ? undefined : eq(accountTable.kind, accountKind);
      const baseFilter = and(searchFilter, kindFilter);

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
      const followersSubq =
        orderBy !== "FOLLOWERS"
          ? null
          : ctx.db
              .select({
                accountId: actorTable.accountId,
                count: sql<number>`COUNT(*)::int`.as("count"),
              })
              .from(followingTable)
              .innerJoin(
                actorTable,
                eq(actorTable.id, followingTable.followeeId),
              )
              .where(
                and(
                  isNotNull(actorTable.accountId),
                  isNotNull(followingTable.accepted),
                ),
              )
              .groupBy(actorTable.accountId)
              .as("followers_agg");

      const followingSubq =
        orderBy !== "FOLLOWING"
          ? null
          : ctx.db
              .select({
                accountId: actorTable.accountId,
                count: sql<number>`COUNT(*)::int`.as("count"),
              })
              .from(followingTable)
              .innerJoin(
                actorTable,
                eq(actorTable.id, followingTable.followerId),
              )
              .where(
                and(
                  isNotNull(actorTable.accountId),
                  isNotNull(followingTable.accepted),
                ),
              )
              .groupBy(actorTable.accountId)
              .as("following_agg");

      const inviteesSubq =
        orderBy !== "INVITED"
          ? null
          : ctx.db
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
      const lastActivityExpr = sql<Date>`COALESCE(${postsSubq.maxPublished}, ${accountTable.updated})`;

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
      let timestamp: boolean;
      let extractSortVal: (r: SortRow) => string;
      switch (orderBy) {
        case "FOLLOWING":
          sortExpr = sql<number>`COALESCE(${followingSubq!.count}, 0)`;
          timestamp = false;
          extractSortVal = (r) => String(r.sortCount);
          break;
        case "FOLLOWERS":
          sortExpr = sql<number>`COALESCE(${followersSubq!.count}, 0)`;
          timestamp = false;
          extractSortVal = (r) => String(r.sortCount);
          break;
        case "POSTS":
          sortExpr = sql<number>`COALESCE(${postsSubq.count}, 0)`;
          timestamp = false;
          extractSortVal = (r) => String(r.sortCount);
          break;
        case "INVITATIONS_LEFT":
          sortExpr = sql`${accountTable.leftInvitations}`;
          timestamp = false;
          extractSortVal = (r) => String(r.account.leftInvitations);
          break;
        case "INVITED":
          sortExpr = sql<number>`COALESCE(${inviteesSubq!.count}, 0)`;
          timestamp = false;
          extractSortVal = (r) => String(r.sortCount);
          break;
        case "LAST_ACTIVITY":
          sortExpr = lastActivityExpr;
          timestamp = true;
          extractSortVal = (r) => r.lastActivityRaw;
          break;
        case "CREATED":
          sortExpr = sql`${accountTable.created}`;
          timestamp = true;
          extractSortVal = (r) => r.createdRaw;
          break;
      }

      const [{ totalCount }] = await ctx.db
        .select({ totalCount: sql<number>`COUNT(*)::int` })
        .from(accountTable)
        .where(baseFilter);

      // --- Cursor filter helpers ---
      // For DESC natural order: "after" a cursor means a smaller value;
      // for ASC natural order: "after" means a larger value.
      function buildAfterFilter(c: AdminCursorData): SQL {
        const cast = timestamp ? "timestamptz" : "bigint";
        const v = sql`${c.val}::${sql.raw(cast)}`;
        const id = sql`${c.id}::uuid`;
        return c.dir === "DESC"
          ? sql`(${sortExpr} < ${v}) OR (${sortExpr} = ${v} AND ${accountTable.id} < ${id})`
          : sql`(${sortExpr} > ${v}) OR (${sortExpr} = ${v} AND ${accountTable.id} > ${id})`;
      }

      function buildBeforeFilter(c: AdminCursorData): SQL {
        const cast = timestamp ? "timestamptz" : "bigint";
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
        async ({
          before,
          after,
          limit,
          inverted,
        }: ResolveCursorConnectionArgs): Promise<AdminAccountRow[]> => {
          const beforeCursor =
            before == null ? null : decodeAdminCursor(before);
          const afterCursor = after == null ? null : decodeAdminCursor(after);

          // Reject cursors that don't match the current sort to prevent
          // wrong pagination or SQL cast errors when the sort changes.
          const validAfter =
            afterCursor != null &&
            afterCursor.field === orderBy &&
            afterCursor.dir === orderDir
              ? afterCursor
              : null;
          const validBefore =
            beforeCursor != null &&
            beforeCursor.field === orderBy &&
            beforeCursor.dir === orderDir
              ? beforeCursor
              : null;

          const afterFilter =
            validAfter == null ? undefined : buildAfterFilter(validAfter);
          const beforeFilter =
            validBefore == null ? undefined : buildBeforeFilter(validBefore);

          // `inverted` flips ORDER BY so resolveCursorConnection can fetch
          // the LAST N items closest to the cursor and then reverse them.
          const descending = (orderDir === "DESC") !== inverted;
          const orderByClause = descending
            ? [desc(sortExpr), desc(accountTable.id)]
            : [asc(sortExpr), asc(accountTable.id)];

          // sortCount carries the active sort field's count expression.
          // For timestamp and INVITATIONS_LEFT sorts it is unused (set to 0).
          const sortCountExpr: SQL<number> = timestamp
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
              lastActivityRaw: sql<string>`to_char(${lastActivityExpr} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`,
              createdRaw: sql<string>`to_char(${accountTable.created} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`,
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
            .where(and(beforeFilter, afterFilter, baseFilter))
            .orderBy(...orderByClause)
            .limit(limit);

          return rows.map((r) => {
            const lastActivityRaw = String(r.lastActivityRaw);
            const rawAct = r.lastActivity as unknown;
            const lastActivity =
              rawAct instanceof Date ? rawAct : new Date(rawAct as string);

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
  }),
);

const InvitationDistributionKind = builder.enumType(
  "InvitationDistributionKind",
  {
    description:
      "Why an invitation distribution happened. `SCHEDULED` is the " +
      "worker's automatic run, `MANUAL` is a moderator pressing the bulk " +
      "regenerate button, and `GRANT` is a moderator granting slots to one " +
      "specific account.",
    values: {
      SCHEDULED: { description: "Automatic worker distribution." },
      MANUAL: { description: "Bulk regeneration triggered by a moderator." },
      GRANT: { description: "Direct grant to one account." },
    },
  },
);

const InvitationDistributionNode = builder.drizzleNode(
  "invitationDistributionTable",
  {
    name: "InvitationDistribution",
    description:
      "An append-only record of one committed invitation distribution. Each " +
      "row is written in the same transaction as the balance change it " +
      "describes. Failed attempts and duplicate task retries do not create " +
      "new rows.",
    authScopes: { moderator: true },
    runScopesOnType: true,
    id: {
      column: (distribution) => distribution.id,
    },
    fields: (t) => ({
      uuid: t.expose("id", {
        type: "UUID",
        description: "The distribution's UUID, stable across lookups.",
      }),
      kind: t.field({
        type: InvitationDistributionKind,
        description: "What triggered this distribution.",
        resolve: (distribution) =>
          distribution.kind.toUpperCase() as "SCHEDULED" | "MANUAL" | "GRANT",
      }),
      created: t.expose("created", {
        type: "DateTime",
        description:
          "When the transaction actually executed. For a delayed automatic " +
          "run this is later than `periodEnd`.",
      }),
      amount: t.exposeInt("amount", {
        description:
          "Number of invitation slots added. This counts slots, not " +
          "invitation links.",
      }),
      accountsAffected: t.exposeInt("accountsAffected", {
        description:
          "Number of accounts whose balance actually changed. Accounts at " +
          "the balance ceiling are skipped and excluded.",
      }),
      eligibleAccountsCount: t.exposeInt("eligibleAccountsCount", {
        nullable: true,
        description:
          "Bulk distributions only: accounts with at least one post in the " +
          "eligibility window.",
      }),
      topThirdCount: t.exposeInt("topThirdCount", {
        nullable: true,
        description:
          "Bulk distributions only: the policy target before capacity " +
          "skips.",
      }),
      cutoffDate: t.expose("cutoffDate", {
        type: "DateTime",
        nullable: true,
        description:
          "Bulk distributions only: the previous cutoff used to select " +
          "active accounts.",
      }),
      periodEnd: t.expose("periodEnd", {
        type: "DateTime",
        nullable: true,
        description:
          "Bulk distributions only: the new logical cutoff written by this " +
          "run. It is the scheduled tick for `SCHEDULED` and the execution " +
          "time for `MANUAL`.",
      }),
      actor: t.relation("actor", {
        type: Account,
        nullable: true,
        description:
          "The moderator who triggered a manual or direct-grant " +
          "distribution. Null for scheduled runs and deleted actors.",
      }),
      actorUsername: t.exposeString("actorUsername", {
        nullable: true,
        description:
          "The actor's username at distribution time, retained if the actor " +
          "is later deleted.",
      }),
      target: t.relation("target", {
        type: Account,
        nullable: true,
        description:
          "The account that received a direct grant. Null for bulk runs and " +
          "deleted accounts.",
      }),
      targetUsername: t.exposeString("targetUsername", {
        nullable: true,
        description:
          "The target's username at grant time, retained if the account is " +
          "later deleted.",
      }),
      note: t.exposeString("note", {
        nullable: true,
        description: "Optional moderator note attached to a direct grant.",
      }),
    }),
  },
);

const InvitationDistributionEdge = builder.simpleObject(
  "InvitationDistributionEdge",
  {
    description: "One row in the invitation distribution history.",
    fields: (t) => ({
      cursor: t.string(),
      node: t.field({ type: InvitationDistributionNode }),
    }),
  },
);

const InvitationDistributionPageInfo = builder.simpleObject(
  "InvitationDistributionPageInfo",
  {
    description: "Pagination state for the invitation distribution history.",
    fields: (t) => ({
      hasNextPage: t.boolean(),
      hasPreviousPage: t.boolean(),
      startCursor: t.string({ nullable: true }),
      endCursor: t.string({ nullable: true }),
    }),
  },
);

const InvitationDistributionConnection = builder.simpleObject(
  "InvitationDistributionConnection",
  {
    description: "A paginated page of committed invitation distributions.",
    fields: (t) => ({
      edges: t.field({ type: [InvitationDistributionEdge] }),
      pageInfo: t.field({ type: InvitationDistributionPageInfo }),
    }),
  },
);

builder.queryField("invitationDistributions", (t) =>
  t.field({
    type: InvitationDistributionConnection,
    nullable: true,
    description:
      "Moderator-only, newest-first history of committed invitation " +
      "distributions. Returns null when the viewer is not a moderator. The " +
      "cursor is opaque and encodes the exact PostgreSQL timestamp, so " +
      "rows committed within the same millisecond paginate correctly.",
    args: {
      first: t.arg.int({
        defaultValue: 20,
        description: "Maximum rows to return, between 1 and 100.",
      }),
      after: t.arg.string({
        description: "Opaque cursor from a previous `endCursor`.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) return null;
      if (!ctx.account?.moderator) return null;
      const page = await getInvitationDistributions(ctx.db, {
        first: args.first ?? undefined,
        after: args.after ?? undefined,
      });
      return {
        edges: page.edges.map((edge) => ({
          cursor: edge.cursor,
          node: edge.distribution,
        })),
        pageInfo: {
          hasNextPage: page.hasNextPage,
          hasPreviousPage: page.hasPreviousPage,
          startCursor: page.startCursor,
          endCursor: page.endCursor,
        },
      };
    },
  }),
);

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
          "The logical end of the last completed eligibility window, or " +
          "null if no regeneration or automatic distribution has run. For a " +
          "delayed automatic tick this is the tick, not the wall-clock " +
          "execution time; use `InvitationDistribution.created` for that.",
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
      autoDistributionEnabled: t.boolean({
        description:
          "Whether the worker is allowed to distribute invitations " +
          "automatically. A moderator can flip this kill switch without a " +
          "deployment.",
      }),
    }),
  },
);

interface InvitationRegenerationStatusShape {
  lastRegenerated: Date | null;
  cutoffDate: Date;
  eligibleAccountsCount: number;
  topThirdCount: number;
  autoDistributionEnabled: boolean;
}

function toInvitationRegenerationStatusShape(
  status: ModelInvitationRegenerationStatus,
): InvitationRegenerationStatusShape {
  return {
    lastRegenerated: status.lastRegenerated,
    cutoffDate: status.cutoffDate,
    eligibleAccountsCount: status.eligibleAccountsCount,
    topThirdCount: status.topThirdCount,
    autoDistributionEnabled: status.autoDistributionEnabled,
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
  }),
);

const RegenerateInvitationsPayload = builder.simpleObject(
  "RegenerateInvitationsPayload",
  {
    description: "The result of a successful invitations regeneration.",
    fields: (t) => ({
      regenerated: t.field({
        type: "DateTime",
        description:
          "The logical end of the eligibility window covered by this run. " +
          "For a delayed scheduled run this is the tick, not the wall-clock " +
          "execution time.",
      }),
      accountsAffected: t.int({
        description:
          "Number of accounts whose `leftInvitations` was incremented.",
      }),
      skipped: t.boolean({
        description:
          "True when this call did not create a new distribution because the " +
          "tick was a duplicate retry or was superseded by a later run.",
      }),
      skipReason: t.string({
        nullable: true,
        description:
          "`duplicate` for an idempotent retry of an already committed tick, " +
          "`superseded` when a later run already advanced the cutoff, or null " +
          "for a new distribution.",
      }),
      distribution: t.field({
        type: InvitationDistributionNode,
        nullable: true,
        description:
          "The committed ledger row. Present for a new distribution and for " +
          "a duplicate retry; null for a superseded tick.",
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
      "last-regen timestamp. The automated worker uses the same operation " +
      "with a scheduled-tick idempotency key.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError],
    },
    async resolve(_root, _args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const result = await regenerateInvitations(ctx.db, ctx.kv, {
        source: "manual",
        actorId: ctx.account.id,
      });
      // Recompute the status against the fresh cutoff: in the common
      // case both eligibility counts are 0 because the cutoff moved
      // to "now", but federation can deliver posts whose `published`
      // is in the future relative to the regenerator's clock, and
      // those still count as eligible after regen.  Hardcoding zeros
      // would silently mislead clients that watch this payload, so
      // pay one aggregate query and report the actual numbers.
      const status = await getInvitationRegenerationStatus(ctx.db, ctx.kv);
      return {
        regenerated: result.regenerated,
        accountsAffected: result.accountsAffected,
        skipped: result.skipped,
        skipReason: result.skipReason,
        distribution: result.distribution,
        status: toInvitationRegenerationStatusShape(status),
      };
    },
  }),
);

const GrantInvitationsInput = builder.inputType("GrantInvitationsInput", {
  description: "Input for granting invitation slots directly to one account.",
  fields: (t) => ({
    accountId: t.globalID({
      for: Account,
      required: true,
      description: "The `Account` global id that should receive the slots.",
    }),
    amount: t.int({
      required: true,
      description:
        "Number of slots to add, from 1 to 10000. This is a safety cap, not " +
        "a product limit.",
    }),
    note: t.string({
      description:
        "Optional moderator note retained in the distribution history " +
        "(maximum 500 characters).",
    }),
  }),
});

const GrantInvitationsPayload = builder.simpleObject(
  "GrantInvitationsPayload",
  {
    description: "The result of a successful direct invitation grant.",
    fields: (t) => ({
      account: t.field({
        type: Account,
        description: "The account whose balance changed.",
      }),
      granted: t.int({ description: "Number of slots granted by this call." }),
      previousBalance: t.int({
        description: "The account's balance before this grant.",
      }),
      newBalance: t.int({
        description: "The account's balance after this grant.",
      }),
      distribution: t.field({
        type: InvitationDistributionNode,
        description: "The committed ledger row for this grant.",
      }),
    }),
  },
);

builder.mutationField("grantInvitations", (t) =>
  t.field({
    type: GrantInvitationsPayload,
    description:
      "Grant a moderator-specified number of invitation slots to one " +
      "account. The account row is locked for the duration of the " +
      "transaction, the balance is checked against the integer ceiling, and " +
      "the grant is recorded in the invitation distribution ledger.",
    args: {
      input: t.arg({
        type: GrantInvitationsInput,
        required: true,
      }),
    },
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const accountId = args.input.accountId.id;
      if (!validateUuid(accountId)) throw new InvalidInputError("accountId");
      if (
        !Number.isSafeInteger(args.input.amount) ||
        args.input.amount < 1 ||
        args.input.amount > MAX_INVITATION_GRANT
      ) {
        throw new InvalidInputError("amount");
      }
      if ((args.input.note?.length ?? 0) > MAX_INVITATION_NOTE_LENGTH) {
        throw new InvalidInputError("note");
      }
      let result;
      try {
        result = await grantInvitations(ctx.db, {
          accountId,
          actorId: ctx.account.id,
          amount: args.input.amount,
          note: args.input.note ?? undefined,
        });
      } catch (error) {
        if (error instanceof RangeError) {
          if (
            error.message === "INVALID_AMOUNT" ||
            error.message === "INVITATION_BALANCE_OVERFLOW"
          ) {
            throw new InvalidInputError("amount");
          }
          if (error.message === "INVALID_NOTE") {
            throw new InvalidInputError("note");
          }
        }
        throw error;
      }
      if (result == null) throw new InvalidInputError("accountId");
      return result;
    },
  }),
);

builder.mutationField("setInvitationAutoDistributionEnabled", (t) =>
  t.field({
    type: InvitationRegenerationStatus,
    description:
      "Enable or disable the worker's automatic invitation distribution " +
      "without a deployment. The setting is stored in `admin_state` and is " +
      "checked before each scheduled tick.",
    args: {
      enabled: t.arg.boolean({ required: true }),
    },
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError],
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      await setInvitationAutoDistributionEnabled(ctx.db, args.enabled);
      return toInvitationRegenerationStatusShape(
        await getInvitationRegenerationStatus(ctx.db, ctx.kv),
      );
    },
  }),
);

const OrphanMediaStatus = builder.simpleObject("OrphanMediaStatus", {
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
});

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
  }),
);

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
  }),
);
