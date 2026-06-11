import { analyzeFlag, createFlag } from "@hackerspub/models/flag";
import { isPostVisibleTo } from "@hackerspub/models/post";
import type {
  Flag as FlagRow,
  FlagStatus as FlagStatusValue,
} from "@hackerspub/models/schema";
import { flagTable } from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import {
  resolveCursorConnection,
  type ResolveCursorConnectionArgs,
} from "@pothos/plugin-relay";
import { assertNever } from "@std/assert/unstable-never";
import { getLogger } from "@logtape/logtape";
import { count, eq } from "drizzle-orm";
import { Account } from "./account.ts";
import { Actor } from "./actor.ts";
import { builder } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { Article, Note, Post, Question } from "./post.ts";
import { NotAuthenticatedError } from "./session.ts";

const logger = getLogger(["hackerspub", "graphql", "moderation"]);

/**
 * The longest report reason accepted from local reporters, in characters.
 */
export const MAX_REPORT_REASON_LENGTH = 4096;
const MIN_REPORT_REASON_LENGTH = 10;

export class DuplicateReportError extends Error {
  public constructor() {
    super("You already have an open report on this target.");
  }
}

builder.objectType(DuplicateReportError, {
  name: "DuplicateReportError",
  description:
    "Returned by `reportContent` when the reporter already has an open " +
    "(pending or reviewing) report on the same target.  A new report can " +
    "be filed once the previous case is resolved.",
  fields: (t) => ({
    duplicateReport: t.string({
      description: "Placeholder field; always an empty string.",
      resolve: () => "",
    }),
  }),
});

export const FlagStatus = builder.enumType("FlagStatus", {
  description:
    "The processing status of an individual report.  Reports are grouped " +
    "into cases; a report's status follows its case's status when the " +
    "case is resolved.",
  values: {
    PENDING: {
      description: "Received and awaiting moderator review.",
    },
    REVIEWING: {
      description: "A moderator is reviewing the case.",
    },
    RESOLVED: {
      description: "Processing complete; a moderation action was taken.",
    },
    DISMISSED: {
      description: "Dismissed; the report was judged not a violation.",
    },
  } as const,
});

export function toFlagStatus(
  status: FlagStatusValue,
): typeof FlagStatus.$inferType {
  return status === "pending"
    ? "PENDING"
    : status === "reviewing"
    ? "REVIEWING"
    : status === "resolved"
    ? "RESOLVED"
    : status === "dismissed"
    ? "DISMISSED"
    : assertNever(status, `Invalid \`FlagStatus\`: "${status}"`);
}

export const Flag = builder.drizzleNode("flagTable", {
  name: "Flag",
  description:
    "An individual report filed against an actor or one of their posts. " +
    "Multiple reports on the same target are grouped into a single case " +
    "for moderators.  A `Flag` is only resolvable by its reporter (their " +
    "own report history) and by moderators; the reported user never sees " +
    "`Flag` values, only the sanitized sanction surface.  Reporter-" +
    "identifying fields (`reporter`) are additionally restricted to " +
    "moderators.",
  authScopes: (flag, ctx) => {
    if (
      ctx.account?.actor != null && flag.reporterId === ctx.account.actor.id
    ) {
      return true;
    }
    return { moderator: true };
  },
  // Run the scope when the node itself is resolved, so a third party
  // cannot even confirm a `Flag` exists via `node(id) { __typename }`.
  runScopesOnType: true,
  id: {
    column: (flag) => flag.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The report's row UUID.",
    }),
    targetActor: t.relation("targetActor", {
      description: "The reported actor (local or remote).",
    }),
    targetPost: t.relation("targetPost", {
      type: Post,
      nullable: true,
      description: "The reported post, for content reports; `null` for user " +
        "(profile) reports, and also when the post row was deleted after " +
        "the report (the snapshot preserves the evidence; " +
        "`targetPostIri` remains as a stable reference).",
    }),
    targetPostIri: t.field({
      type: "URL",
      nullable: true,
      description:
        "The reported post's ActivityPub IRI; survives post deletion. " +
        "`null` for user (profile) reports.",
      select: { columns: { targetPostIri: true } },
      resolve: (flag) =>
        flag.targetPostIri == null ? null : new URL(flag.targetPostIri),
    }),
    reason: t.exposeString("reason", {
      description:
        "The reporter's written reason.  Visible to the reporter and " +
        "moderators only; never shown to the reported user, and never " +
        "forwarded to remote instances (a moderator-written summary is " +
        "sent instead), since the wording itself could identify the " +
        "reporter.",
    }),
    status: t.field({
      type: FlagStatus,
      description: "The report's processing status.",
      select: { columns: { status: true } },
      resolve: (flag) => toFlagStatus(flag.status),
    }),
    forwardToRemote: t.exposeBoolean("forwardToRemote", {
      description:
        "Whether the reporter opted in to forwarding this report to the " +
        "target's remote instance after moderator action.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When the report was filed.",
    }),
    updated: t.expose("updated", {
      type: "DateTime",
      description: "When the report was last updated.",
    }),
    reporter: t.relation("reporter", {
      description:
        "The reporting actor: a local user's actor for in-app reports, " +
        "or the sending remote actor (typically the remote instance " +
        "actor) for reports received via ActivityPub.  Moderator-only: " +
        "reporter identity is strictly confidential.",
      authScopes: { moderator: true },
    }),
    external: t.field({
      type: "Boolean",
      description: "Whether this report arrived from another instance via an " +
        "ActivityPub `Flag` activity (as opposed to being filed in-app " +
        "by a local user).  External reports provide less context and " +
        "come from unknown moderation cultures, so moderators should " +
        "apply additional scrutiny.  Moderator-only.",
      authScopes: { moderator: true },
      select: { columns: { iri: true } },
      resolve: (flag) => flag.iri != null,
    }),
    cocVersion: t.exposeString("cocVersion", {
      nullable: true,
      description: "The hash of the most recent Git commit that touched the " +
        "CODE_OF_CONDUCT files when the report was filed, so the report " +
        "can be interpreted against the code of conduct text it was " +
        "filed under.  Moderator-only.  `null` when the version could " +
        "not be determined.",
      authScopes: { moderator: true },
    }),
    llmAnalysis: t.expose("llmAnalysis", {
      type: "JSON",
      nullable: true,
      description:
        "The LLM's code of conduct matching result (`matches` with " +
        "provision ids, confidences, and rationales; `summary`; `model`; " +
        "`analyzedAt`; `error` when the analysis failed).  A reference " +
        "tool for moderators, never an automated decision: always verify " +
        "independently.  Moderator-only.  `null` while the analysis is " +
        "still pending.",
      authScopes: { moderator: true },
    }),
  }),
});

builder.mutationField("reportContent", (t) =>
  t.field({
    type: Flag,
    description: "Report a post (`Note`, `Article`, or `Question`) or a user " +
      "(`Actor`) for violating the code of conduct.  Requires " +
      "authentication.  The free-form `reason` needs no knowledge of " +
      "specific provisions; it must be between 10 and 4096 characters. " +
      "Reports on the same target are grouped into one case for " +
      "moderators, but each reporter can have only one open report per " +
      "target (`DuplicateReportError` otherwise).  The reporter's " +
      "identity is kept strictly confidential.",
    errors: {
      types: [NotAuthenticatedError, InvalidInputError, DuplicateReportError],
    },
    args: {
      targetId: t.arg.globalID({
        for: [Actor, Note, Article, Question],
        required: true,
        description:
          "The reported target: an `Actor` for user reports, or a post " +
          "for content reports.",
      }),
      reason: t.arg.string({
        required: true,
        description: "Why this content or user is being reported, in the " +
          "reporter's own words (10–4096 characters).",
      }),
      forwardToRemote: t.arg.boolean({
        required: false,
        description:
          "Opt in to forwarding this report to the target's remote " +
          "instance after moderator action (the moderation team's " +
          "summary is sent, never this `reason` text).  Only meaningful " +
          "for remote targets; ignored for local ones.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      const reason = args.reason.trim();
      if (
        reason.length < MIN_REPORT_REASON_LENGTH ||
        reason.length > MAX_REPORT_REASON_LENGTH
      ) {
        throw new InvalidInputError("reason");
      }
      if (!validateUuid(args.targetId.id)) {
        throw new InvalidInputError("targetId");
      }
      const targetUuid = args.targetId.id as Uuid;
      let targetActor: NonNullable<
        Awaited<ReturnType<typeof ctx.db.query.actorTable.findFirst>>
      >;
      let targetPost:
        | Parameters<typeof createFlag>[1]["targetPost"]
        | undefined;
      if (args.targetId.typename === Actor.name) {
        const actor = await ctx.db.query.actorTable.findFirst({
          where: { id: targetUuid },
        });
        if (actor == null) throw new InvalidInputError("targetId");
        targetActor = actor;
      } else {
        const post = await ctx.db.query.postTable.findFirst({
          where: { id: targetUuid },
          with: {
            actor: {
              with: {
                followers: { where: { followerId: ctx.account.actor.id } },
                blockees: { where: { blockeeId: ctx.account.actor.id } },
                blockers: { where: { blockerId: ctx.account.actor.id } },
              },
            },
            mentions: { where: { actorId: ctx.account.actor.id } },
          },
        });
        if (post == null || !isPostVisibleTo(post, ctx.account.actor)) {
          throw new InvalidInputError("targetId");
        }
        targetPost = post;
        targetActor = post.actor;
      }
      if (targetActor.id === ctx.account.actor.id) {
        throw new InvalidInputError("targetId");
      }
      const flag = await createFlag(ctx.db, {
        reporter: ctx.account.actor,
        targetActor,
        targetPost,
        reason,
        forwardToRemote: args.forwardToRemote ?? false,
      });
      if (flag == null) throw new DuplicateReportError();
      // Fire-and-forget: the LLM code of conduct matching runs in the
      // background on the root database handle and stores its result (or
      // failure) in flag.llmAnalysis; it never blocks report creation.
      const analyzer = ctx.fedCtx.data.models.moderationAnalyzer;
      if (analyzer != null) {
        void analyzeFlag(ctx.db, analyzer, flag, flag.snapshot)
          .catch((error) => {
            logger.error(
              "Failed to analyze flag {flagId}: {error}",
              { flagId: flag.id, error },
            );
          });
      }
      return flag;
    },
  }));

builder.drizzleObjectFields(Account, (t) => ({
  reports: t.connection({
    type: Flag,
    description: "The account's own report history, newest first: what they " +
      "reported, when, their written reason, and the processing status. " +
      "Detailed outcome information is deliberately not exposed here, so " +
      "reports cannot be used to probe moderation boundaries.  Resolvable " +
      "by the account owner and moderators only.",
    authScopes: (account) => ({
      moderator: true,
      selfAccount: account.id,
    }),
    nullable: true,
    async resolve(account, args, ctx) {
      const actor = await ctx.db.query.actorTable.findFirst({
        where: { accountId: account.id },
        columns: { id: true },
      });
      if (actor == null) return null;
      const connection = await resolveCursorConnection(
        {
          args,
          toCursor: (flag: FlagRow) => flag.id,
        },
        ({ before, after, limit, inverted }: ResolveCursorConnectionArgs) =>
          ctx.db.query.flagTable.findMany({
            where: {
              reporterId: actor.id,
              ...(after != null && validateUuid(after)
                ? { id: { lt: after as Uuid } }
                : {}),
              ...(before != null && validateUuid(before)
                ? { id: { gt: before as Uuid } }
                : {}),
            },
            // Flag ids are UUIDv7, so id order is creation order.
            orderBy: { id: inverted ? "asc" : "desc" },
            limit,
          }),
      );
      const [{ count: totalCount }] = await ctx.db
        .select({ count: count() })
        .from(flagTable)
        .where(eq(flagTable.reporterId, actor.id));
      return { ...connection, totalCount };
    },
  }, {
    name: "AccountReportsConnection",
    fields: (t) => ({
      totalCount: t.int({
        description: "Total number of reports this account has filed.",
        resolve: (parent) =>
          (parent as unknown as { totalCount: number }).totalCount,
      }),
    }),
  }),
}));
