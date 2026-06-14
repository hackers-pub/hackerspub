import { getCocProvisions } from "@hackerspub/models/coc";
import { analyzeFlag, createFlag } from "@hackerspub/models/flag";
import {
  APPEAL_WINDOW_MS,
  assignCase,
  createAppeal,
  getModerationStatistics,
  getViolationHistory,
  isActorBanned,
  listSanctionedActors,
  resolveAppeal as resolveAppealModel,
  takeModerationAction as takeModerationActionModel,
  updateCaseStatus,
} from "@hackerspub/models/moderation";
import {
  countUnreadModerationNotifications,
  markModerationNotificationsRead,
} from "@hackerspub/models/moderation-notification";
import { isPostVisibleTo } from "@hackerspub/models/post";
import type {
  Account as AccountRow,
  Flag as FlagRow,
  FlagAction as FlagActionRow,
  FlagActionType as FlagActionTypeValue,
  FlagAppeal as FlagAppealRow,
  FlagAppealResult as FlagAppealResultValue,
  FlagAppealStatus as FlagAppealStatusValue,
  FlagCase as FlagCaseRow,
  FlagStatus as FlagStatusValue,
  ModerationNotification as ModerationNotificationRow,
  ModerationNotificationType as ModerationNotificationTypeValue,
} from "@hackerspub/models/schema";
import { flagTable } from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import {
  resolveCursorConnection,
  type ResolveCursorConnectionArgs,
} from "@pothos/plugin-relay";
import { assertNever } from "@std/assert/unstable-never";
import { getLogger } from "@logtape/logtape";
import { and, count, eq, ne, sql } from "drizzle-orm";
import { Account } from "./account.ts";
import { Actor } from "./actor.ts";
import { builder, type UserContext } from "./builder.ts";
import { InvalidInputError, NotAuthorizedError } from "./error.ts";
import {
  getAppealResolvedEmail,
  getModerationActionEmail,
} from "./moderation-email.ts";
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

export function fromFlagStatus(
  status: typeof FlagStatus.$inferType,
): FlagStatusValue {
  return status === "PENDING"
    ? "pending"
    : status === "REVIEWING"
    ? "reviewing"
    : status === "RESOLVED"
    ? "resolved"
    : status === "DISMISSED"
    ? "dismissed"
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
    // A reported moderator must not read reports against themselves:
    // the moderator scope alone would expose the reporters' identities
    // and wording on their own case.
    if (
      ctx.account?.actor != null &&
      flag.targetActorId === ctx.account.actor.id
    ) {
      return false;
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
            // isPostVisibleTo() fails closed on a share wrapper whose
            // sharedPost is not loaded, so a boost must hydrate it to be
            // reportable (and to stay hidden when the boosted author is
            // sanction-hidden).
            sharedPost: { with: { actor: true } },
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
      // A moderator may read any account's report history, but must never
      // learn who reported *them*: exclude reports whose target is the
      // viewer's own actor.  This is a no-op for the account owner's own
      // view (self-reports are rejected, so none of their reports target
      // themselves) and keeps the self-target anonymity guard intact for
      // both the edges and `totalCount`.
      const viewerActorId = ctx.account?.actor.id;
      const connection = await resolveCursorConnection(
        {
          args,
          toCursor: (flag: FlagRow) => flag.id,
        },
        ({ before, after, limit, inverted }: ResolveCursorConnectionArgs) =>
          ctx.db.query.flagTable.findMany({
            where: {
              reporterId: actor.id,
              ...(viewerActorId == null
                ? {}
                : { targetActorId: { ne: viewerActorId } }),
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
        .where(
          viewerActorId == null ? eq(flagTable.reporterId, actor.id) : and(
            eq(flagTable.reporterId, actor.id),
            ne(flagTable.targetActorId, viewerActorId),
          ),
        );
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

export const FlagActionType = builder.enumType("FlagActionType", {
  description:
    "The kind of decision a moderator records on a case.  The spirit of " +
    "the system is graduated response: warning, then content censorship, " +
    "then temporary suspension, with permanent suspension as the last " +
    "resort; severe violations may skip stages.",
  values: {
    DISMISS: {
      description: "No code of conduct violation was found.",
    },
    WARNING: {
      description:
        "A warning message; for minor first offenses without apparent " +
        "malice.",
    },
    CENSOR: {
      description: "Hide the reported post from timelines, search, and " +
        "recommendations; its permalink shows a censorship notice and " +
        "the author keeps access.  Requires a post target.",
    },
    SUSPEND: {
      description:
        "Temporary suspension: the local user cannot create posts, " +
        "react, boost, vote, or follow until the window ends (a remote " +
        "actor is federation-blocked instead).  Requires a suspension " +
        "window.",
    },
    BAN: {
      description:
        "Permanent suspension: a local account can no longer log in and " +
        "its content is hidden; a remote actor is permanently " +
        "federation-blocked.",
    },
  } as const,
});

export function toFlagActionType(
  actionType: FlagActionTypeValue,
): typeof FlagActionType.$inferType {
  return actionType === "dismiss"
    ? "DISMISS"
    : actionType === "warning"
    ? "WARNING"
    : actionType === "censor"
    ? "CENSOR"
    : actionType === "suspend"
    ? "SUSPEND"
    : actionType === "ban"
    ? "BAN"
    : assertNever(actionType, `Invalid \`FlagActionType\`: "${actionType}"`);
}

export function fromFlagActionType(
  actionType: typeof FlagActionType.$inferType,
): FlagActionTypeValue {
  return actionType === "DISMISS"
    ? "dismiss"
    : actionType === "WARNING"
    ? "warning"
    : actionType === "CENSOR"
    ? "censor"
    : actionType === "SUSPEND"
    ? "suspend"
    : actionType === "BAN"
    ? "ban"
    : assertNever(actionType, `Invalid \`FlagActionType\`: "${actionType}"`);
}

export const ContentSnapshot = builder.drizzleNode("contentSnapshotTable", {
  name: "ContentSnapshot",
  description: "The reported content as it looked when the report was filed: " +
    "evidence that survives even if the reported user edits or deletes " +
    "the original.  Moderator-only; a reported moderator cannot access " +
    "snapshots of their own case.",
  authScopes: async (snapshot, ctx) => {
    if (ctx.account?.actor != null) {
      const flag = await ctx.db.query.flagTable.findFirst({
        where: { id: snapshot.flagId },
        columns: { targetActorId: true },
      });
      if (flag?.targetActorId === ctx.account.actor.id) return false;
    }
    return { moderator: true };
  },
  runScopesOnType: true,
  id: {
    column: (snapshot) => snapshot.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The snapshot's row UUID.",
    }),
    postIri: t.field({
      type: "URL",
      nullable: true,
      description: "The snapshotted post's ActivityPub IRI; survives post " +
        "deletion.  `null` for profile snapshots.",
      select: { columns: { postIri: true } },
      resolve: (snapshot) =>
        snapshot.postIri == null ? null : new URL(snapshot.postIri),
    }),
    contentHtml: t.expose("contentHtml", {
      type: "HTML",
      description:
        "The rendered HTML at snapshot time: the post's content for " +
        "content reports, or the actor's bio for user (profile) reports.",
    }),
    sourceContent: t.exposeString("sourceContent", {
      nullable: true,
      description:
        "The original source markup at snapshot time; only available " +
        "for local posts (`null` for remote posts and profile " +
        "snapshots).",
    }),
    metadata: t.expose("metadata", {
      type: "JSON",
      nullable: true,
      description:
        "Contextual metadata captured at snapshot time: the author's " +
        "handle and display name, the post type, title, language, " +
        "visibility, sensitivity, media URLs, and publication time.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When the snapshot was captured.",
    }),
  }),
});

export const FlagAction = builder.drizzleNode("flagActionTable", {
  name: "FlagAction",
  description:
    "An immutable audit record of a moderator decision on a case.  If a " +
    "decision changes (e.g. through an appeal), a new action is recorded " +
    "rather than editing this one.  Moderator-only: the reported user " +
    "sees the sanitized sanction surface instead, which never names the " +
    "acting moderator; a reported moderator likewise cannot access " +
    "actions on their own case through this type.",
  authScopes: async (action, ctx) => {
    if (ctx.account?.actor != null) {
      const flagCase = await ctx.db.query.flagCaseTable.findFirst({
        where: { id: action.caseId },
        columns: { targetActorId: true },
      });
      if (flagCase?.targetActorId === ctx.account.actor.id) return false;
    }
    return { moderator: true };
  },
  runScopesOnType: true,
  id: {
    column: (action) => action.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The action's row UUID.",
    }),
    case: t.relation("case", {
      description: "The case this action resolves.",
    }),
    moderator: t.relation("moderator", {
      description:
        "The moderator who made this decision.  Internal audit trail " +
        "only: never revealed to the reported user (notifications go " +
        "out under the moderation team's collective identity), so " +
        "moderators cannot become individual harassment targets.",
    }),
    actionType: t.field({
      type: FlagActionType,
      description: "The decision that was made.",
      select: { columns: { actionType: true } },
      resolve: (action) => toFlagActionType(action.actionType),
    }),
    violatedProvisions: t.exposeStringList("violatedProvisions", {
      description:
        "The code of conduct provision ids the moderator confirmed as " +
        "violated (empty for dismissals).  These are the human-confirmed " +
        "counterpart of `Flag.llmAnalysis`; their divergence is " +
        "surfaced in the moderation statistics to monitor LLM bias and " +
        "automation bias.",
    }),
    rationale: t.exposeString("rationale", {
      description:
        "The moderator's internal judgment rationale.  May contain " +
        "details not appropriate to share with the reported user; those " +
        "go to `messageToUser`.",
    }),
    messageToUser: t.exposeString("messageToUser", {
      nullable: true,
      description: "The message shown to the reported user, sent under the " +
        "moderation team's collective identity.",
    }),
    suspensionStarts: t.expose("suspensionStarts", {
      type: "DateTime",
      nullable: true,
      description:
        "The suspension window's start; only set for `SUSPEND` actions.",
    }),
    suspensionEnds: t.expose("suspensionEnds", {
      type: "DateTime",
      nullable: true,
      description:
        "The suspension window's end; only set for `SUSPEND` actions.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When the action was taken.",
    }),
  }),
});

export const FlagCase = builder.drizzleNode("flagCaseTable", {
  name: "FlagCase",
  description:
    "A moderation case: all reports against the same target (an actor, " +
    "or one of their posts) grouped into a single unit of moderator " +
    "work.  Cases are created automatically by the first report and " +
    "joined by subsequent ones while open.  Moderator-only; a reported " +
    "moderator cannot access their own case (reporter anonymity would " +
    "be broken otherwise).",
  authScopes: (flagCase, ctx) => {
    if (
      ctx.account?.actor != null &&
      flagCase.targetActorId === ctx.account.actor.id
    ) {
      return false;
    }
    return { moderator: true };
  },
  runScopesOnType: true,
  id: {
    column: (flagCase) => flagCase.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The case's row UUID.",
    }),
    targetActor: t.relation("targetActor", {
      description: "The reported actor (local or remote).",
    }),
    targetPost: t.relation("targetPost", {
      type: Post,
      nullable: true,
      description: "The reported post, for content reports; `null` for user " +
        "(profile) reports and for posts deleted after the report (the " +
        "snapshots on the member reports preserve the evidence).",
    }),
    targetPostIri: t.field({
      type: "URL",
      nullable: true,
      description:
        "The reported post's ActivityPub IRI; keeps the case attached " +
        "to a stable target reference even after post deletion.  `null` " +
        "for user (profile) reports.",
      select: { columns: { targetPostIri: true } },
      resolve: (flagCase) =>
        flagCase.targetPostIri == null ? null : new URL(flagCase.targetPostIri),
    }),
    status: t.field({
      type: FlagStatus,
      description: "The case's processing status.",
      select: { columns: { status: true } },
      resolve: (flagCase) => toFlagStatus(flagCase.status),
    }),
    assignedModerator: t.relation("assignedModerator", {
      nullable: true,
      description: "The moderator the case is assigned to, for workload " +
        "distribution; `null` when unassigned.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When the first report opened this case.",
    }),
    resolved: t.expose("resolved", {
      type: "DateTime",
      nullable: true,
      description:
        "When the case was resolved or dismissed; `null` while open.",
    }),
    flags: t.relatedConnection("flags", {
      description:
        "The individual reports grouped into this case, oldest first. " +
        "Each report's reason is preserved individually; combining " +
        "diverse reasons enables more accurate judgment.",
      query: () => ({ orderBy: { created: "asc" } }),
    }),
    reportCount: t.int({
      description:
        "How many reports this case has accumulated.  Higher counts " +
        "mean higher priority: multiple independent reporters finding " +
        "the same issue suggests severity.",
      select: { columns: { id: true } },
      resolve: async (flagCase, _args, ctx) => {
        const [{ count: reportCount }] = await ctx.db
          .select({ count: count() })
          .from(flagTable)
          .where(eq(flagTable.caseId, flagCase.id));
        return reportCount;
      },
    }),
    forwardingEnabled: t.boolean({
      description:
        "Whether a non-dismiss action on this case would be forwarded to " +
        "the target's remote instance: the target is a remote actor (no " +
        "local account) and at least one report opted into forwarding. " +
        "When `true`, `takeModerationAction` requires a `forwardSummary` " +
        "for non-dismiss actions, so the internal `rationale` (which may " +
        "carry reporter-identifying wording) is never externalized.  " +
        "Computed over all of the case's reports, not just a page of them.",
      select: { columns: { id: true, targetActorId: true } },
      resolve: async (flagCase, _args, ctx) => {
        const targetActor = await ctx.db.query.actorTable.findFirst({
          where: { id: flagCase.targetActorId },
          columns: { accountId: true },
        });
        if (targetActor == null || targetActor.accountId != null) return false;
        const optIn = await ctx.db.query.flagTable.findFirst({
          where: { caseId: flagCase.id, forwardToRemote: true },
          columns: { id: true },
        });
        return optIn != null;
      },
    }),
    actions: t.field({
      type: [FlagAction],
      description:
        "The immutable audit trail of decisions on this case, oldest " +
        "first.  A case usually has one action; appeals that reduce or " +
        "increase a sanction append replacement actions.",
      select: { columns: { id: true } },
      resolve: (flagCase, _args, ctx) =>
        ctx.db.query.flagActionTable.findMany({
          where: { caseId: flagCase.id },
          orderBy: { created: "asc" },
        }),
    }),
    violationHistory: t.field({
      type: [FlagAction],
      description:
        "The target actor's standing moderation history across all " +
        "cases, newest first: dismissals are excluded, actions " +
        "withdrawn or replaced on appeal drop out, and warnings expire " +
        "after a violation-free year.  Accumulated history affects " +
        "subsequent sanction levels.",
      select: { columns: { targetActorId: true } },
      resolve: (flagCase, _args, ctx) =>
        getViolationHistory(ctx.db, flagCase.targetActorId),
    }),
  }),
});

builder.drizzleObjectFields(Flag, (t) => ({
  case: t.relation("case", {
    description:
      "The case this report is grouped into.  Moderator-only: the case " +
      "aggregates other reporters' reports.",
    authScopes: { moderator: true },
  }),
  snapshot: t.relation("snapshot", {
    nullable: true,
    description: "The content snapshot captured when this report was filed, " +
      "preserving the evidence even if the original is edited or " +
      "deleted.  Moderator-only.",
    authScopes: { moderator: true },
  }),
}));

builder.queryField("moderationCases", (t) =>
  t.connection({
    type: FlagCase,
    nullable: true,
    description:
      "Moderator-only queue of moderation cases, newest first.  Returns " +
      "`null` for non-moderators; routes should guard with " +
      "`viewer.moderator`.  Use `status: PENDING` for the open queue, " +
      "`minReportCount` for the high-priority section, and `search` to " +
      "match the target's handle or name.",
    args: {
      status: t.arg({
        type: FlagStatus,
        required: false,
        description: "Only cases with this status.",
      }),
      minReportCount: t.arg.int({
        required: false,
        description:
          "Only cases with at least this many reports, e.g. `5` for " +
          "the high-priority section.",
      }),
      search: t.arg.string({
        required: false,
        description: "Match the target actor's handle or display name " +
          "(case-insensitive substring).",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null || !ctx.account?.moderator) return null;
      const search = args.search?.trim();
      // A reported moderator must not see their own case in the queue.
      const viewerActorId = ctx.account.actor.id;
      const connection = await resolveCursorConnection(
        {
          args,
          toCursor: (flagCase: FlagCaseRow) => flagCase.id,
        },
        ({ before, after, limit, inverted }: ResolveCursorConnectionArgs) =>
          ctx.db.query.flagCaseTable.findMany({
            where: {
              targetActorId: { ne: viewerActorId },
              ...(args.status == null
                ? {}
                : { status: fromFlagStatus(args.status) }),
              ...(args.minReportCount == null ? {} : {
                RAW: (flagCase) =>
                  sql`(
                    select count(*) from ${flagTable} f
                    where f.case_id = ${flagCase.id}
                  ) >= ${args.minReportCount}`,
              }),
              ...(search == null || search === "" ? {} : {
                targetActor: {
                  OR: [
                    { handle: { ilike: `%${search}%` } },
                    { name: { ilike: `%${search}%` } },
                  ],
                },
              }),
              ...(after != null && validateUuid(after)
                ? { id: { lt: after as Uuid } }
                : {}),
              ...(before != null && validateUuid(before)
                ? { id: { gt: before as Uuid } }
                : {}),
            },
            // Case ids are UUIDv7, so id order is creation order.
            orderBy: { id: inverted ? "asc" : "desc" },
            limit,
          }),
      );
      return connection;
    },
  }));

builder.queryField("flagCaseByUuid", (t) =>
  t.drizzleField({
    type: FlagCase,
    nullable: true,
    description:
      "Moderator-only lookup of a single moderation case by its row " +
      "UUID, for the case detail page.  Returns `null` for unknown " +
      "UUIDs and for non-moderators.",
    args: {
      uuid: t.arg({
        type: "UUID",
        required: true,
        description: "The case's row UUID (`FlagCase.uuid`).",
      }),
    },
    async resolve(query, _root, args, ctx) {
      if (ctx.session == null || !ctx.account?.moderator) return null;
      if (!validateUuid(args.uuid)) return null;
      // A reported moderator must not look up their own case.
      return await ctx.db.query.flagCaseTable.findFirst(
        query({
          where: {
            id: args.uuid,
            targetActorId: { ne: ctx.account.actor.id },
          },
        }),
      ) ?? null;
    },
  }));

builder.queryField("sanctionedActors", (t) =>
  t.field({
    type: [Actor],
    nullable: true,
    description:
      "Moderator-only list of actors currently under an active sanction " +
      "(temporary suspension, permanent suspension, or federation " +
      "block), most recently sanctioned first.  Sanction activeness is " +
      "evaluated lazily by time comparison, so expired suspensions " +
      "disappear from this list on their own.  Returns `null` for " +
      "non-moderators.",
    async resolve(_root, _args, ctx) {
      if (ctx.session == null || !ctx.account?.moderator) return null;
      return await listSanctionedActors(ctx.db);
    },
  }));

builder.mutationField("assignFlagCase", (t) =>
  t.field({
    type: FlagCase,
    nullable: true,
    description: "Assign an open moderation case to a moderator for workload " +
      "distribution (or unassign it by omitting `moderatorId`). " +
      "Assigning a pending case moves it to `REVIEWING`.  Requires a " +
      "moderator account.  Returns `null` when the case is not open or " +
      "the assignee is not a moderator.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError],
    },
    args: {
      caseId: t.arg.globalID({
        for: FlagCase,
        required: true,
        description: "The case to (un)assign.",
      }),
      moderatorId: t.arg.globalID({
        for: Account,
        required: false,
        description: "The moderator to assign; omit to unassign.  Must be an " +
          "account with moderator privileges.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      if (!validateUuid(args.caseId.id)) return null;
      if (args.moderatorId != null && !validateUuid(args.moderatorId.id)) {
        return null;
      }
      // A reported moderator cannot act on their own case; behave as if
      // it does not exist.
      const flagCase = await ctx.db.query.flagCaseTable.findFirst({
        where: { id: args.caseId.id as Uuid },
        columns: { targetActorId: true },
      });
      if (flagCase?.targetActorId === ctx.account.actor.id) return null;
      return await assignCase(
        ctx.db,
        args.caseId.id as Uuid,
        (args.moderatorId?.id as Uuid | undefined) ?? null,
      ) ?? null;
    },
  }));

builder.mutationField("updateFlagCaseStatus", (t) =>
  t.field({
    type: FlagCase,
    nullable: true,
    description:
      "Move an open moderation case between `PENDING` and `REVIEWING`. " +
      "Resolution happens exclusively through `takeModerationAction`. " +
      "Requires a moderator account.  Returns `null` when the case is " +
      "not open.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    args: {
      caseId: t.arg.globalID({
        for: FlagCase,
        required: true,
        description: "The case to update.",
      }),
      status: t.arg({
        type: FlagStatus,
        required: true,
        description: "The new status; only `PENDING` or `REVIEWING`.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      if (args.status !== "PENDING" && args.status !== "REVIEWING") {
        throw new InvalidInputError("status");
      }
      if (!validateUuid(args.caseId.id)) return null;
      // A reported moderator cannot act on their own case; behave as if
      // it does not exist.
      const flagCase = await ctx.db.query.flagCaseTable.findFirst({
        where: { id: args.caseId.id as Uuid },
        columns: { targetActorId: true },
      });
      if (flagCase?.targetActorId === ctx.account.actor.id) return null;
      return await updateCaseStatus(
        ctx.db,
        args.caseId.id as Uuid,
        args.status === "PENDING" ? "pending" : "reviewing",
      ) ?? null;
    },
  }));

builder.mutationField("takeModerationAction", (t) =>
  t.field({
    type: FlagAction,
    description: "Record a moderation decision on an open case and apply its " +
      "effects: `DISMISS` dismisses the case; `WARNING` records a " +
      "warning; `CENSOR` hides the reported post from listings (its " +
      "permalink keeps a notice); `SUSPEND` suspends the target for the " +
      "given window; `BAN` suspends permanently.  Every action except " +
      "`DISMISS` requires `violatedProvisions`.  For a **local** target, " +
      "the reported user is notified in-app and (for sanctions) by email, " +
      "always under the moderation team's collective identity, and can " +
      "appeal within 14 days (a `DISMISS` notifies only when " +
      "`messageToUser` is set).  A **remote** target has no local " +
      "notification or appeal: a `WARNING` is only recorded, a `CENSOR` " +
      "hides the locally cached post, and a `SUSPEND` or `BAN` applies a " +
      "temporary or permanent federation block.  When a reporter opted in " +
      "(see `FlagCase.forwardingEnabled`) a `Flag` activity carrying " +
      "`forwardSummary` is sent to the remote instance from the instance " +
      "actor; in that case a non-empty `forwardSummary` is required for " +
      "non-dismiss actions (`InvalidInputError` otherwise) so the internal " +
      "`rationale` is never externalized.  That forwarding is best-effort " +
      "and happens after the decision is committed: a send failure is logged " +
      "server-side and does not fail this mutation (the action still " +
      "succeeds).  Requires a moderator account.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    args: {
      caseId: t.arg.globalID({
        for: FlagCase,
        required: true,
        description: "The open case to act on.",
      }),
      actionType: t.arg({
        type: FlagActionType,
        required: true,
        description: "The decision.",
      }),
      violatedProvisions: t.arg.stringList({
        required: false,
        description:
          "The code of conduct provision ids confirmed as violated. " +
          "Required (non-empty) for every action except `DISMISS`, and " +
          "rejected for `DISMISS` (a dismissal confirms no violation; " +
          "recorded provisions would skew the statistics).",
      }),
      rationale: t.arg.string({
        required: true,
        description:
          "The internal judgment rationale, recorded for the audit " +
          "trail and consistency across moderators.  Not shown to the " +
          "reported user.",
      }),
      messageToUser: t.arg.string({
        required: false,
        description: "The message shown to the reported user (under the " +
          "moderation team's collective identity).  For `DISMISS`, " +
          "providing a message opts into the educational dismissal " +
          "notification.",
      }),
      suspensionStarts: t.arg({
        type: "DateTime",
        required: false,
        description:
          "Suspension start; required for (and only for) `SUSPEND`. " +
          "Must not be in the future (a few minutes of clock skew are " +
          "tolerated and clamped to the server clock).",
      }),
      suspensionEnds: t.arg({
        type: "DateTime",
        required: false,
        description: "Suspension end; required for (and only for) `SUSPEND`.",
      }),
      forwardSummary: t.arg.string({
        required: false,
        description:
          "Moderator-written summary for the outgoing `Flag` activity " +
          "when forwarding to the target's remote instance.  Required " +
          "(non-empty) for non-dismiss actions when " +
          "`FlagCase.forwardingEnabled` is `true`.  Never include the " +
          "reporter's wording.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      if (!ctx.account.moderator) throw new NotAuthorizedError();
      if (!validateUuid(args.caseId.id)) {
        throw new InvalidInputError("caseId");
      }
      // A reported moderator cannot act on their own case; behave as if
      // it does not exist.
      const targetCheck = await ctx.db.query.flagCaseTable.findFirst({
        where: { id: args.caseId.id as Uuid },
        columns: { targetActorId: true },
      });
      if (targetCheck?.targetActorId === ctx.account.actor.id) {
        throw new InvalidInputError("caseId");
      }
      const actionType = fromFlagActionType(args.actionType);
      const provisions = args.violatedProvisions ?? [];
      if (actionType !== "dismiss" && provisions.length < 1) {
        throw new InvalidInputError("violatedProvisions");
      }
      // A dismissal confirms no violation, so provisions are rejected:
      // they would skew the statistics, which count provisions across
      // all recorded actions.
      if (actionType === "dismiss" && provisions.length > 0) {
        throw new InvalidInputError("violatedProvisions");
      }
      const rationale = args.rationale.trim();
      if (rationale.length < 1) throw new InvalidInputError("rationale");
      if (actionType === "suspend") {
        const skewAllowanceMs = 5 * 60 * 1000;
        if (
          args.suspensionStarts == null ||
          args.suspensionStarts.getTime() > Date.now() + skewAllowanceMs
        ) {
          throw new InvalidInputError("suspensionStarts");
        }
        if (
          args.suspensionEnds == null ||
          args.suspensionEnds <= args.suspensionStarts ||
          args.suspensionEnds <= new Date()
        ) {
          throw new InvalidInputError("suspensionEnds");
        }
      } else if (
        args.suspensionStarts != null || args.suspensionEnds != null
      ) {
        throw new InvalidInputError("suspensionStarts");
      }
      if (actionType === "censor") {
        // Preflight for a precise error; the model revalidates under lock.
        // Only open cases qualify: a closed case keeps the "caseId" error.
        const flagCase = await ctx.db.query.flagCaseTable.findFirst({
          where: {
            id: args.caseId.id as Uuid,
            status: { in: ["pending", "reviewing"] },
          },
          columns: { targetPostId: true },
        });
        if (flagCase != null && flagCase.targetPostId == null) {
          throw new InvalidInputError("actionType");
        }
      }
      // A forwarded `Flag` carries `forwardSummary`, never the internal
      // `rationale`; require a summary when this non-dismiss action will be
      // forwarded to a remote instance, so reporter-identifying wording in
      // the rationale cannot leak.
      if (
        actionType !== "dismiss" &&
        (args.forwardSummary == null || args.forwardSummary.trim() === "")
      ) {
        const flagCase = await ctx.db.query.flagCaseTable.findFirst({
          where: {
            id: args.caseId.id as Uuid,
            status: { in: ["pending", "reviewing"] },
          },
          columns: { id: true },
          with: { targetActor: { columns: { accountId: true } } },
        });
        if (flagCase != null && flagCase.targetActor.accountId == null) {
          const optIn = await ctx.db.query.flagTable.findFirst({
            where: { caseId: flagCase.id, forwardToRemote: true },
            columns: { id: true },
          });
          if (optIn != null) throw new InvalidInputError("forwardSummary");
        }
      }
      const action = await takeModerationActionModel(ctx.fedCtx, {
        caseId: args.caseId.id as Uuid,
        moderator: ctx.account,
        actionType,
        violatedProvisions: provisions,
        rationale,
        messageToUser: args.messageToUser ?? undefined,
        suspensionStarts: args.suspensionStarts ?? undefined,
        suspensionEnds: args.suspensionEnds ?? undefined,
        forwardSummary: args.forwardSummary?.trim() || undefined,
      });
      if (action == null) throw new InvalidInputError("caseId");
      if (actionType !== "dismiss") {
        await sendModerationActionEmail(ctx, action).catch((error) => {
          logger.error(
            "Failed to send the moderation action email for action " +
              "{actionId}: {error}",
            { actionId: action.id, error },
          );
        });
      }
      return action;
    },
  }));

/**
 * Emails the sanctioned local user about the action, in their preferred
 * locale, at their verified addresses.  Best-effort: failures are logged
 * by the caller and never roll back the action.  Built exclusively from
 * moderator-authored fields.
 */
async function sendModerationActionEmail(
  ctx: UserContext,
  action: FlagActionRow,
): Promise<void> {
  const flagCase = await ctx.db.query.flagCaseTable.findFirst({
    where: { id: action.caseId },
    with: {
      targetActor: { with: { account: { with: { emails: true } } } },
      targetPost: true,
    },
  });
  const account = flagCase?.targetActor.account;
  if (flagCase == null || account == null) return;
  const emails = account.emails.filter((email) => email.verified != null);
  if (emails.length < 1) return;
  const locale = new Intl.Locale(account.locales?.[0] ?? "en");
  const appealUrl = new URL(
    `/@${account.username}/settings/sanctions`,
    ctx.fedCtx.canonicalOrigin,
  ).href;
  const targetUrl = flagCase.targetPost?.url ??
    flagCase.targetPost?.iri ?? flagCase.targetPostIri;
  // Send to every verified address: for a BAN the user cannot sign in,
  // so this email is the documented appeal channel and must reach
  // whichever address the user still has access to.
  const messages = await Promise.all(
    emails.map(({ email }) =>
      getModerationActionEmail({
        locale,
        to: email,
        action,
        targetUrl: targetUrl ?? null,
        appealUrl,
      })
    ),
  );
  for await (const receipt of ctx.email.sendMany(messages)) {
    if (!receipt.successful) {
      logger.error(
        "Failed to deliver the moderation action email for action " +
          "{actionId}: {errors}",
        { actionId: action.id, errors: receipt.errorMessages },
      );
    }
  }
}

export const FlagAppealStatus = builder.enumType("FlagAppealStatus", {
  description: "The processing status of an appeal.",
  values: {
    PENDING: { description: "Filed and awaiting review." },
    REVIEWING: { description: "A moderator is reviewing the appeal." },
    RESOLVED: { description: "The review is complete; see `result`." },
  } as const,
});

export const FlagAppealResult = builder.enumType("FlagAppealResult", {
  description: "The outcome of an appeal review.",
  values: {
    DISMISSED: {
      description: "The appeal was dismissed; the original action stands.",
    },
    REDUCED: {
      description:
        "The action was reduced to a lighter one (e.g. suspension to " +
        "warning); the replacement is recorded as a new action.",
    },
    WITHDRAWN: {
      description:
        "The action was withdrawn: its enforcement is reverted and it " +
        "drops out of the violation history.",
    },
    INCREASED: {
      description:
        "Rare: review uncovered a more severe violation, and the action " +
        "was replaced with a heavier one.",
    },
  } as const,
});

export function toFlagAppealStatus(
  status: FlagAppealStatusValue,
): typeof FlagAppealStatus.$inferType {
  return status === "pending"
    ? "PENDING"
    : status === "reviewing"
    ? "REVIEWING"
    : status === "resolved"
    ? "RESOLVED"
    : assertNever(status, `Invalid \`FlagAppealStatus\`: "${status}"`);
}

export function fromFlagAppealStatus(
  status: typeof FlagAppealStatus.$inferType,
): FlagAppealStatusValue {
  return status === "PENDING"
    ? "pending"
    : status === "REVIEWING"
    ? "reviewing"
    : status === "RESOLVED"
    ? "resolved"
    : assertNever(status, `Invalid \`FlagAppealStatus\`: "${status}"`);
}

export function toFlagAppealResult(
  result: FlagAppealResultValue,
): typeof FlagAppealResult.$inferType {
  return result === "dismissed"
    ? "DISMISSED"
    : result === "reduced"
    ? "REDUCED"
    : result === "withdrawn"
    ? "WITHDRAWN"
    : result === "increased"
    ? "INCREASED"
    : assertNever(result, `Invalid \`FlagAppealResult\`: "${result}"`);
}

export function fromFlagAppealResult(
  result: typeof FlagAppealResult.$inferType,
): FlagAppealResultValue {
  return result === "DISMISSED"
    ? "dismissed"
    : result === "REDUCED"
    ? "reduced"
    : result === "WITHDRAWN"
    ? "withdrawn"
    : result === "INCREASED"
    ? "increased"
    : assertNever(result, `Invalid \`FlagAppealResult\`: "${result}"`);
}

export const FlagAppeal = builder.drizzleNode("flagAppealTable", {
  name: "FlagAppeal",
  description:
    "An appeal a sanctioned user filed against a moderation action. " +
    "Resolvable by the appellant (their own appeal) and by moderators; " +
    "moderator-only fields (`action`, `appellant`, `reviewer`) carry an " +
    "additional scope so the appellant cannot reach the case, the other " +
    "reports, or the moderators through their appeal.",
  authScopes: (appeal, ctx) => {
    if (ctx.account != null && appeal.appellantId === ctx.account.id) {
      return true;
    }
    return { moderator: true };
  },
  runScopesOnType: true,
  id: {
    column: (appeal) => appeal.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The appeal's row UUID.",
    }),
    reason: t.exposeString("reason", {
      description: "Why the appellant believes the action is unjust.",
    }),
    additionalContext: t.exposeString("additionalContext", {
      nullable: true,
      description:
        "Context or evidence the appellant believes was not considered.",
    }),
    status: t.field({
      type: FlagAppealStatus,
      description: "The appeal's processing status.",
      select: { columns: { status: true } },
      resolve: (appeal) => toFlagAppealStatus(appeal.status),
    }),
    result: t.field({
      type: FlagAppealResult,
      nullable: true,
      description: "The review outcome; `null` until resolved.",
      select: { columns: { result: true } },
      resolve: (appeal) =>
        appeal.result == null ? null : toFlagAppealResult(appeal.result),
    }),
    reviewRationale: t.exposeString("reviewRationale", {
      nullable: true,
      description:
        "The reviewing moderator's rationale, shown to the appellant " +
        "under the moderation team's collective identity.  `null` until " +
        "resolved.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When the appeal was filed.",
    }),
    resolved: t.expose("resolved", {
      type: "DateTime",
      nullable: true,
      description: "When the review completed; `null` while open.",
    }),
    action: t.relation("action", {
      description: "The appealed action, with its full audit context.  " +
        "Moderator-only; a moderator who is themselves the appellant is " +
        "excluded, like everywhere else on their own case.",
      authScopes: (appeal, _args, ctx) =>
        ctx.account != null && appeal.appellantId === ctx.account.id
          ? false
          : { moderator: true },
    }),
    appellant: t.relation("appellant", {
      description: "The account that filed the appeal.  Moderator-only; " +
        "a moderator who is themselves the appellant is excluded.",
      authScopes: (appeal, _args, ctx) =>
        ctx.account != null && appeal.appellantId === ctx.account.id
          ? false
          : { moderator: true },
    }),
    reviewer: t.relation("reviewer", {
      nullable: true,
      description:
        "The moderator who reviewed the appeal; `null` until resolved. " +
        "Moderator-only: preferably a different moderator than the one " +
        "who took the original action, and never revealed to the " +
        "appellant, including an appellant who is themselves a moderator.",
      authScopes: (appeal, _args, ctx) =>
        ctx.account != null && appeal.appellantId === ctx.account.id
          ? false
          : { moderator: true },
    }),
  }),
});

builder.queryField("moderationAppeals", (t) =>
  t.connection({
    type: FlagAppeal,
    nullable: true,
    description:
      "Moderator-only queue of appeals against moderation actions, newest " +
      "first.  Returns `null` for non-moderators; routes should guard with " +
      "`viewer.moderator`.  Use `status: PENDING` for the open queue.  A " +
      "moderator's own appeals are excluded: an appellant cannot review " +
      "their own appeal, and sees it through `Account.sanctions` instead.",
    args: {
      status: t.arg({
        type: FlagAppealStatus,
        required: false,
        description: "Only appeals with this status.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null || !ctx.account?.moderator) return null;
      // A moderator-appellant must not review (nor break on the
      // moderator-only fields of) their own appeal in the queue; they
      // see it through Account.sanctions like any sanctioned user.
      const viewerAccountId = ctx.account.id;
      return await resolveCursorConnection(
        {
          args,
          toCursor: (appeal: FlagAppealRow) => appeal.id,
        },
        ({ before, after, limit, inverted }: ResolveCursorConnectionArgs) =>
          ctx.db.query.flagAppealTable.findMany({
            where: {
              appellantId: { ne: viewerAccountId },
              ...(args.status == null
                ? {}
                : { status: fromFlagAppealStatus(args.status) }),
              ...(after != null && validateUuid(after)
                ? { id: { lt: after as Uuid } }
                : {}),
              ...(before != null && validateUuid(before)
                ? { id: { gt: before as Uuid } }
                : {}),
            },
            // Appeal ids are UUIDv7, so id order is creation order.
            orderBy: { id: inverted ? "asc" : "desc" },
            limit,
          }),
      );
    },
  }));

interface SanctionShape {
  action: FlagActionRow;
  targetPostIri: string | null;
  appeal: FlagAppealRow | null;
}

const Sanction = builder.objectRef<SanctionShape>("Sanction");

Sanction.implement({
  description:
    "The sanitized surface a sanctioned (or warned) user sees about a " +
    "moderation action taken on them: the confirmed violations, the " +
    "action, the target content reference, and the moderation team's " +
    "message.  Deliberately absent: the reporters, their reasons, the " +
    "report count, the internal rationale, and the acting moderator's " +
    "identity (everything is presented under the moderation team's " +
    "collective identity).",
  fields: (t) => ({
    uuid: t.field({
      type: "UUID",
      description: "The underlying action's row UUID; pass it to " +
        "`appealModerationAction` as `sanctionId`.",
      resolve: (sanction) => sanction.action.id,
    }),
    actionType: t.field({
      type: FlagActionType,
      description: "What was decided.  `DISMISS` appears here only when the " +
        "moderation team opted into the educational dismissal " +
        "notification by writing a message.",
      resolve: (sanction) => toFlagActionType(sanction.action.actionType),
    }),
    violatedProvisions: t.stringList({
      description: "The code of conduct provision ids the moderation team " +
        "confirmed as violated (empty for dismissals).",
      resolve: (sanction) => sanction.action.violatedProvisions,
    }),
    messageToUser: t.string({
      nullable: true,
      description: "The moderation team's message.",
      resolve: (sanction) => sanction.action.messageToUser,
    }),
    suspensionStarts: t.field({
      type: "DateTime",
      nullable: true,
      description: "The suspension window's start, for `SUSPEND` actions.",
      resolve: (sanction) => sanction.action.suspensionStarts,
    }),
    suspensionEnds: t.field({
      type: "DateTime",
      nullable: true,
      description: "The suspension window's end, for `SUSPEND` actions.",
      resolve: (sanction) => sanction.action.suspensionEnds,
    }),
    targetPostIri: t.field({
      type: "URL",
      nullable: true,
      description:
        "The sanctioned post's ActivityPub IRI, when the action targeted " +
        "a post; `null` for account-level actions.",
      resolve: (sanction) =>
        sanction.targetPostIri == null ? null : new URL(sanction.targetPostIri),
    }),
    created: t.field({
      type: "DateTime",
      description: "When the action was taken.",
      resolve: (sanction) => sanction.action.created,
    }),
    appealableUntil: t.field({
      type: "DateTime",
      description:
        "The appeal deadline: 14 days after the action.  One appeal per " +
        "action.",
      resolve: (sanction) =>
        new Date(sanction.action.created.getTime() + APPEAL_WINDOW_MS),
    }),
    appeal: t.field({
      type: FlagAppeal,
      nullable: true,
      description:
        "The user's appeal against this action, or `null` when none was " +
        "filed.",
      resolve: (sanction) => sanction.appeal,
    }),
  }),
});

builder.drizzleObjectFields(Account, (t) => ({
  sanctions: t.field({
    type: [Sanction],
    nullable: true,
    description:
      "The moderation actions taken on this account, newest first, as " +
      "the sanitized surface the user themselves sees (dismissals appear " +
      "only when the moderation team wrote an educational message). " +
      "Resolvable by the account owner and moderators only.",
    authScopes: (account) => ({
      moderator: true,
      selfAccount: account.id,
    }),
    async resolve(account, _args, ctx) {
      const actor = await ctx.db.query.actorTable.findFirst({
        where: { accountId: account.id },
        columns: { id: true },
      });
      if (actor == null) return [];
      const actions = await ctx.db.query.flagActionTable.findMany({
        where: { case: { targetActorId: actor.id } },
        with: { appeal: true, case: { columns: { targetPostIri: true } } },
        orderBy: { created: "desc" },
      });
      return actions
        .filter((action) =>
          action.actionType !== "dismiss" || action.messageToUser != null
        )
        .map((action) => ({
          action,
          targetPostIri: action.case.targetPostIri,
          appeal: action.appeal,
        }));
    },
  }),
}));

builder.mutationField("appealModerationAction", (t) =>
  t.field({
    type: FlagAppeal,
    description: "File an appeal against a moderation action taken on you " +
      "(`Sanction.uuid` is the `sanctionId`).  Only the sanctioned user " +
      "can appeal, within 14 days of the action, once per action; " +
      "dismissals cannot be appealed.  The review outcome arrives as a " +
      "moderation notification.  Requires authentication.  Banned users " +
      "cannot sign in to appeal, so they appeal by replying to the " +
      "sanction email; a moderator then files the appeal on their behalf " +
      "via `onBehalfOf`.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    args: {
      sanctionId: t.arg({
        type: "UUID",
        required: true,
        description: "The appealed action's row UUID (`Sanction.uuid`).",
      }),
      onBehalfOf: t.arg.globalID({
        for: Account,
        required: false,
        description:
          "Moderator-only: file the appeal on behalf of this sanctioned " +
          "account.  Used for banned users, who cannot sign in and " +
          "appeal by replying to the sanction email instead.  The appeal " +
          "is still subject to the 14-day window and the one-appeal-per-" +
          "action rule, and the named account must be the sanction's " +
          "target.",
      }),
      reason: t.arg.string({
        required: true,
        description:
          "Why you believe the action is unjust (1–4096 characters).",
      }),
      additionalContext: t.arg.string({
        required: false,
        description: "Context or evidence you believe was not considered " +
          "(up to 4096 characters).",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      const reason = args.reason.trim();
      if (reason.length < 1 || reason.length > MAX_REPORT_REASON_LENGTH) {
        throw new InvalidInputError("reason");
      }
      if (
        args.additionalContext != null &&
        args.additionalContext.length > MAX_REPORT_REASON_LENGTH
      ) {
        throw new InvalidInputError("additionalContext");
      }
      if (!validateUuid(args.sanctionId)) {
        throw new InvalidInputError("sanctionId");
      }
      let appellant = ctx.account as AccountRow;
      if (args.onBehalfOf != null) {
        if (!ctx.account.moderator) throw new NotAuthorizedError();
        if (!validateUuid(args.onBehalfOf.id)) {
          throw new InvalidInputError("onBehalfOf");
        }
        const target = await ctx.db.query.accountTable.findFirst({
          where: { id: args.onBehalfOf.id as Uuid },
        });
        if (target == null) throw new InvalidInputError("onBehalfOf");
        appellant = target;
      }
      const appeal = await createAppeal(ctx.db, {
        actionId: args.sanctionId,
        appellant,
        reason,
        additionalContext: args.additionalContext ?? undefined,
      });
      if (appeal == null) throw new InvalidInputError("sanctionId");
      return appeal;
    },
  }));

const ReplacementActionInput = builder.inputType("ReplacementActionInput", {
  description:
    "The replacement sanction recorded when an appeal review reduces or " +
    "increases the original action.  Validated like a regular action: " +
    "`violatedProvisions` must be non-empty, `CENSOR` needs a post " +
    "target, `SUSPEND` needs a valid window, and `DISMISS` is not a " +
    "replacement (use the `WITHDRAWN` result instead).",
  fields: (t) => ({
    actionType: t.field({
      type: FlagActionType,
      required: true,
      description:
        "The replacement decision; `DISMISS` is not allowed (use the " +
        "`WITHDRAWN` appeal result instead).",
    }),
    violatedProvisions: t.stringList({
      required: true,
      description: "The confirmed code of conduct provision ids.",
    }),
    rationale: t.string({
      required: true,
      description: "The internal rationale for the replacement.",
    }),
    messageToUser: t.string({
      required: false,
      description: "The message shown to the sanctioned user.",
    }),
    suspensionStarts: t.field({
      type: "DateTime",
      required: false,
      description:
        "Suspension start; required for (and only for) `SUSPEND`.  Must " +
        "not be in the future (a few minutes of clock skew are " +
        "tolerated).",
    }),
    suspensionEnds: t.field({
      type: "DateTime",
      required: false,
      description: "Suspension end; required for (and only for) `SUSPEND`.",
    }),
  }),
});

builder.mutationField("resolveFlagAppeal", (t) =>
  t.field({
    type: FlagAppeal,
    description: "Resolve an appeal: `DISMISSED` keeps the original action, " +
      "`WITHDRAWN` reverts its enforcement, and `REDUCED`/`INCREASED` " +
      "replace it with the given `replacement` action on the same case. " +
      "The appellant is notified under the moderation team's collective " +
      "identity.  Preferably reviewed by a different moderator than the " +
      "original decision-maker; the UI surfaces a warning via " +
      "`FlagAppeal.action.moderator`, but this is not enforced.  " +
      "Requires a moderator account.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    args: {
      appealId: t.arg.globalID({
        for: FlagAppeal,
        required: true,
        description: "The open appeal to resolve.",
      }),
      result: t.arg({
        type: FlagAppealResult,
        required: true,
        description: "The review outcome.",
      }),
      reviewRationale: t.arg.string({
        required: true,
        description: "The review rationale, shown to the appellant under the " +
          "moderation team's collective identity.",
      }),
      replacement: t.arg({
        type: ReplacementActionInput,
        required: false,
        description: "The replacement action; required for (and only for) " +
          "`REDUCED` and `INCREASED` results.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      if (!ctx.account.moderator) throw new NotAuthorizedError();
      if (!validateUuid(args.appealId.id)) {
        throw new InvalidInputError("appealId");
      }
      // A moderator cannot review the appeal of their own sanction
      // (the appellant is the reported user, so this would be
      // self-judging); behave as if the appeal does not exist.
      const appealRow = await ctx.db.query.flagAppealTable.findFirst({
        where: { id: args.appealId.id as Uuid },
        columns: { appellantId: true },
      });
      if (appealRow?.appellantId === ctx.account.id) {
        throw new InvalidInputError("appealId");
      }
      const result = fromFlagAppealResult(args.result);
      const needsReplacement = result === "reduced" || result === "increased";
      if (needsReplacement !== (args.replacement != null)) {
        throw new InvalidInputError("replacement");
      }
      const reviewRationale = args.reviewRationale.trim();
      if (reviewRationale.length < 1) {
        throw new InvalidInputError("reviewRationale");
      }
      let replacement:
        | NonNullable<
          Parameters<typeof resolveAppealModel>[1]["replacement"]
        >
        | undefined;
      if (args.replacement != null) {
        const replacementType = fromFlagActionType(
          args.replacement.actionType,
        );
        if (replacementType === "dismiss") {
          throw new InvalidInputError("replacement.actionType");
        }
        if (args.replacement.violatedProvisions.length < 1) {
          throw new InvalidInputError("replacement.violatedProvisions");
        }
        if (replacementType === "suspend") {
          const skewAllowanceMs = 5 * 60 * 1000;
          if (
            args.replacement.suspensionStarts == null ||
            args.replacement.suspensionStarts.getTime() >
              Date.now() + skewAllowanceMs
          ) {
            throw new InvalidInputError("replacement.suspensionStarts");
          }
          if (
            args.replacement.suspensionEnds == null ||
            args.replacement.suspensionEnds <=
              args.replacement.suspensionStarts ||
            args.replacement.suspensionEnds <= new Date()
          ) {
            throw new InvalidInputError("replacement.suspensionEnds");
          }
        } else if (
          args.replacement.suspensionStarts != null ||
          args.replacement.suspensionEnds != null
        ) {
          throw new InvalidInputError("replacement.suspensionStarts");
        }
        const replacementRationale = args.replacement.rationale.trim();
        if (replacementRationale.length < 1) {
          throw new InvalidInputError("replacement.rationale");
        }
        if (replacementType === "censor") {
          // Preflight for a precise error; the model revalidates under
          // lock.  Only open appeals qualify.
          const appealRow = await ctx.db.query.flagAppealTable.findFirst({
            where: {
              id: args.appealId.id as Uuid,
              status: { in: ["pending", "reviewing"] },
            },
            with: {
              action: { with: { case: { columns: { targetPostId: true } } } },
            },
          });
          if (
            appealRow != null && appealRow.action.case.targetPostId == null
          ) {
            throw new InvalidInputError("replacement.actionType");
          }
        }
        replacement = {
          actionType: replacementType,
          violatedProvisions: args.replacement.violatedProvisions,
          rationale: replacementRationale,
          messageToUser: args.replacement.messageToUser ?? undefined,
          suspensionStarts: args.replacement.suspensionStarts ?? undefined,
          suspensionEnds: args.replacement.suspensionEnds ?? undefined,
        };
      }
      // Capture the appellant's ban state *before* resolving: a successful
      // ban appeal lifts the ban, so checking only the post-resolution state
      // would skip the outcome email for exactly the users who appealed by
      // email (banned, unable to sign in) and most need to learn the result.
      const priorAppeal = await ctx.db.query.flagAppealTable.findFirst({
        where: { id: args.appealId.id as Uuid },
        with: { appellant: { with: { actor: true } } },
      });
      const appellantWasBanned = priorAppeal?.appellant?.actor != null &&
        isActorBanned(priorAppeal.appellant.actor);
      const appeal = await resolveAppealModel(ctx.db, {
        appealId: args.appealId.id as Uuid,
        reviewer: ctx.account,
        result,
        reviewRationale,
        replacement,
      });
      if (appeal == null) throw new InvalidInputError("appealId");
      // An appellant banned either before or after the resolution cannot
      // rely on the in-app appeal_resolved notification: while still banned
      // they cannot sign in to read it, and a successful ban appeal lifts the
      // ban but the user (who appealed by email, locked out) has no reason to
      // know to sign in.  Either way the outcome is emailed to every verified
      // address.  A failed send must not fail the resolution itself.
      try {
        const appellant = await ctx.db.query.accountTable.findFirst({
          where: { id: appeal.appellantId },
          with: { actor: true, emails: true },
        });
        if (
          appellant != null &&
          (appellantWasBanned || isActorBanned(appellant.actor))
        ) {
          const emails = appellant.emails
            .filter((email) => email.verified != null);
          const locale = new Intl.Locale(appellant.locales?.[0] ?? "en");
          const messages = await Promise.all(emails.map(({ email }) =>
            getAppealResolvedEmail({ locale, to: email, appeal })
          ));
          for await (const receipt of ctx.email.sendMany(messages)) {
            if (!receipt.successful) {
              logger.error(
                "Failed to deliver the appeal resolution email for " +
                  "appeal {appealId}: {errors}",
                { appealId: appeal.id, errors: receipt.errorMessages },
              );
            }
          }
        }
      } catch (error) {
        logger.error(
          "Failed to email the appeal resolution for appeal {appealId}: " +
            "{error}",
          { appealId: appeal.id, error },
        );
      }
      return appeal;
    },
  }));

export const ModerationNotificationType = builder.enumType(
  "ModerationNotificationType",
  {
    description:
      "What a moderation notification is about.  These are deliberately " +
      "separate from regular notifications: their reference shape does " +
      "not fit the post-centric notification table, and reporter " +
      "identities must never surface through notification actors.",
    values: {
      FLAG_RECEIVED: {
        description: "A new report was filed (sent to every moderator).",
      },
      ACTION_TAKEN: {
        description:
          "A moderation action was taken on the recipient (sent under " +
          "the moderation team's collective identity).",
      },
      APPEAL_RECEIVED: {
        description: "An appeal was filed (sent to every moderator).",
      },
      APPEAL_RESOLVED: {
        description: "The recipient's appeal was reviewed.",
      },
      SUSPENSION_ENDING: {
        description:
          "The recipient's temporary suspension ends within 24 hours.",
      },
    } as const,
  },
);

export function toModerationNotificationType(
  type: ModerationNotificationTypeValue,
): typeof ModerationNotificationType.$inferType {
  return type === "flag_received"
    ? "FLAG_RECEIVED"
    : type === "action_taken"
    ? "ACTION_TAKEN"
    : type === "appeal_received"
    ? "APPEAL_RECEIVED"
    : type === "appeal_resolved"
    ? "APPEAL_RESOLVED"
    : type === "suspension_ending"
    ? "SUSPENSION_ENDING"
    : assertNever(type, `Invalid \`ModerationNotificationType\`: "${type}"`);
}

export const ModerationNotification = builder.drizzleNode(
  "moderationNotificationTable",
  {
    name: "ModerationNotification",
    description:
      "A notification about moderation activity, resolvable only by its " +
      "recipient.  Everything a sanctioned recipient can reach through " +
      "it is the sanitized sanction surface, presented under the " +
      "moderation team's collective identity.",
    authScopes: (notification) => ({
      selfAccount: notification.accountId,
    }),
    runScopesOnType: true,
    id: {
      column: (notification) => notification.id,
    },
    fields: (t) => ({
      uuid: t.expose("id", {
        type: "UUID",
        description: "The notification's row UUID.",
      }),
      type: t.field({
        type: ModerationNotificationType,
        description: "What this notification is about.",
        select: { columns: { type: true } },
        resolve: (notification) =>
          toModerationNotificationType(notification.type),
      }),
      read: t.expose("read", {
        type: "DateTime",
        nullable: true,
        description: "When the recipient read the notification; `null` while " +
          "unread.",
      }),
      created: t.expose("created", {
        type: "DateTime",
        description: "When the notification was created.",
      }),
      sanction: t.field({
        type: Sanction,
        nullable: true,
        description: "The sanitized sanction surface, for `ACTION_TAKEN` and " +
          "`SUSPENSION_ENDING` notifications; `null` for other types.",
        select: { columns: { actionId: true } },
        async resolve(notification, _args, ctx) {
          if (notification.actionId == null) return null;
          const action = await ctx.db.query.flagActionTable.findFirst({
            where: { id: notification.actionId },
            with: {
              appeal: true,
              case: { columns: { targetPostIri: true } },
            },
          });
          if (action == null) return null;
          return {
            action,
            targetPostIri: action.case.targetPostIri,
            appeal: action.appeal,
          };
        },
      }),
      case: t.relation("case", {
        nullable: true,
        description:
          "The case a `FLAG_RECEIVED` notification points at; `null` " +
          "for other types.  Moderator-only (only moderators receive " +
          "`FLAG_RECEIVED`).",
        authScopes: { moderator: true },
      }),
      appeal: t.relation("appeal", {
        nullable: true,
        description: "The appeal an `APPEAL_RECEIVED` or `APPEAL_RESOLVED` " +
          "notification points at; `null` for other types.  Guarded by " +
          "`FlagAppeal`'s own scopes (the appellant or moderators).",
      }),
    }),
  },
);

builder.drizzleObjectFields(Account, (t) => ({
  moderationNotifications: t.connection({
    type: ModerationNotification,
    nullable: true,
    description: "The account's moderation notifications, newest first.  " +
      "Resolvable by the account owner only.",
    authScopes: (account) => ({ selfAccount: account.id }),
    async resolve(account, args, ctx) {
      return await resolveCursorConnection(
        {
          args,
          toCursor: (notification: ModerationNotificationRow) =>
            notification.id,
        },
        ({ before, after, limit, inverted }: ResolveCursorConnectionArgs) =>
          ctx.db.query.moderationNotificationTable.findMany({
            where: {
              accountId: account.id,
              ...(after != null && validateUuid(after)
                ? { id: { lt: after as Uuid } }
                : {}),
              ...(before != null && validateUuid(before)
                ? { id: { gt: before as Uuid } }
                : {}),
            },
            // Notification ids are UUIDv7: id order is creation order.
            orderBy: { id: inverted ? "asc" : "desc" },
            limit,
          }),
      );
    },
  }),
  unreadModerationNotificationCount: t.int({
    nullable: true,
    description:
      "How many of the account's moderation notifications are unread, " +
      "e.g. for the sidebar badge.  Resolvable by the account owner " +
      "only.",
    authScopes: (account) => ({ selfAccount: account.id }),
    resolve: (account, _args, ctx) =>
      countUnreadModerationNotifications(ctx.db, account.id),
  }),
}));

builder.mutationField("markModerationNotificationsRead", (t) =>
  t.field({
    type: "Int",
    description: "Mark the viewer's unread moderation notifications as read " +
      "(optionally only those up to the notification with the given " +
      "id) and return how many were affected.  Idempotent.  Requires " +
      "authentication.",
    args: {
      upToId: t.arg.globalID({
        for: ModerationNotification,
        required: false,
        description:
          "Mark only notifications created up to (and including) this " +
          "one; omit to mark everything.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      if (args.upToId != null && !validateUuid(args.upToId.id)) return 0;
      return await markModerationNotificationsRead(
        ctx.db,
        ctx.account.id,
        (args.upToId?.id as Uuid | undefined) ?? undefined,
      );
    },
  }));

const ModerationActionCount = builder.simpleObject("ModerationActionCount", {
  description: "How many actions of one type were taken in the range.",
  fields: (t) => ({
    actionType: t.field({
      type: FlagActionType,
      description: "The action type.",
    }),
    count: t.int({ description: "How many actions of this type." }),
  }),
});

const ModerationProvisionCount = builder.simpleObject(
  "ModerationProvisionCount",
  {
    description:
      "How often one code of conduct provision was confirmed as violated.",
    fields: (t) => ({
      provision: t.string({ description: "The provision id." }),
      count: t.int({ description: "How many confirmed violations." }),
    }),
  },
);

const ModerationLlmDivergence = builder.simpleObject(
  "ModerationLlmDivergence",
  {
    description:
      "The divergence between LLM-suggested (`Flag.llmAnalysis`) and " +
      "moderator-confirmed (`FlagAction.violatedProvisions`) provisions. " +
      "High divergence localized to particular provisions, languages, or " +
      "user groups signals unreliable or biased matching; near-zero " +
      "divergence is also a warning sign (automation bias: moderators " +
      "rubber-stamping LLM output).",
    fields: (t) => ({
      compared: t.int({
        description:
          "How many analyzed reports on closed cases were compared.  " +
          "Failed analyses (an `error` in `Flag.llmAnalysis`) are " +
          "skipped, and the confirmed set counts only standing actions.",
      }),
      diverged: t.int({
        description:
          "How many had LLM suggestions differing from the confirmed " +
          "set.",
      }),
    }),
  },
);

const ModerationStatistics = builder.simpleObject("ModerationStatistics", {
  description:
    "Aggregated moderation activity for the statistics screen: queue " +
    "health, action distribution (a healthy one is mostly dismissals " +
    "and warnings), the most-violated provisions (guides community " +
    "education), and the LLM matching divergence.",
  fields: (t) => ({
    totalReports: t.int({
      description: "Reports filed in the range.",
    }),
    processedReports: t.int({
      description: "Reports whose processing finished (resolved or dismissed).",
    }),
    averageProcessingHours: t.float({
      nullable: true,
      description: "Average hours from a case's creation to its resolution; " +
        "`null` when no case has been resolved in the range.",
    }),
    actionDistribution: t.field({
      type: [ModerationActionCount],
      description: "How taken actions distribute over the action types.",
    }),
    topViolatedProvisions: t.field({
      type: [ModerationProvisionCount],
      description: "The five most-confirmed provisions.",
    }),
    llmDivergence: t.field({
      type: ModerationLlmDivergence,
      nullable: true,
      description:
        "The LLM matching divergence; `null` when no analyzed report " +
        "has been processed yet.",
    }),
  }),
});

builder.queryField("moderationStatistics", (t) =>
  t.field({
    type: ModerationStatistics,
    nullable: true,
    description:
      "Moderator-only aggregated moderation statistics over the given " +
      "range (all time by default).  Returns `null` for non-moderators.",
    args: {
      since: t.arg({
        type: "DateTime",
        required: false,
        description: "Start of the range (inclusive).",
      }),
      until: t.arg({
        type: "DateTime",
        required: false,
        description: "End of the range (inclusive).",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null || !ctx.account?.moderator) return null;
      const stats = await getModerationStatistics(ctx.db, {
        since: args.since ?? undefined,
        until: args.until ?? undefined,
      });
      return {
        ...stats,
        actionDistribution: stats.actionDistribution.map((entry) => ({
          actionType: toFlagActionType(entry.actionType),
          count: entry.count,
        })),
      };
    },
  }));

const CocProvision = builder.simpleObject("CocProvision", {
  description:
    "A single provision of the code of conduct (an H3 subsection of the " +
    "document).  Provision ids are structural (`section.subsection`) and " +
    "identical across locales, but only stable for a given version of " +
    "the document; reports record the `cocVersion` they were filed " +
    "under.",
  fields: (t) => ({
    id: t.string({
      description: 'The structural id, e.g. `"2.3"`.',
    }),
    section: t.string({
      description: "The title of the section the provision belongs to.",
    }),
    title: t.string({ description: "The provision's title." }),
    text: t.string({ description: "The provision's Markdown body." }),
  }),
});

builder.queryField("codeOfConductProvisions", (t) =>
  t.field({
    type: [CocProvision],
    description:
      "The current code of conduct, parsed into provisions, in the " +
      "given locale (or the nearest available one; English by default). " +
      "Backs the report form's guidance and the moderation action " +
      "form's provision picker.",
    args: {
      locale: t.arg({
        type: "Locale",
        required: false,
        description: "The preferred locale for titles and text.",
      }),
    },
    resolve: (_root, args) => getCocProvisions(args.locale?.toString()),
  }));
