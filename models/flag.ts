import { getLogger } from "@logtape/logtape";
import type { ApplicationModel } from "./context.ts";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getCocProvisions, getCocVersion } from "./coc.ts";
import type { Database, Transaction } from "./db.ts";
import { createFlagReceivedNotifications } from "./moderation-notification.ts";
import {
  type Actor,
  type ContentSnapshot,
  type ContentSnapshotMetadata,
  contentSnapshotTable,
  type Flag,
  type FlagCase,
  flagCaseTable,
  type FlagLlmAnalysis,
  flagTable,
  type Post,
} from "./schema.ts";
import type { AiServices } from "./services.ts";
import { generateUuidV7 } from "./uuid.ts";

function isTransaction(db: Database): db is Transaction {
  return "rollback" in db;
}

const logger = getLogger(["hackerspub", "models", "flag"]);

/**
 * The minimum length of a report reason written by a local user.  External
 * reports received via ActivityPub `Flag` activities are exempt, since
 * other implementations may deliver shorter comments.
 */
export const MIN_REPORT_REASON_LENGTH = 10;

export interface CreateFlagOptions {
  /**
   * The reporting actor.  A local user's actor for in-app reports, or the
   * sending remote actor (typically the remote instance actor) for reports
   * received via ActivityPub.
   */
  reporter: Actor;
  /** The reported actor. */
  targetActor: Actor;
  /**
   * The reported post, for content reports.  Must belong to `targetActor`.
   * Omit for user (profile) reports.
   */
  targetPost?: Post;
  /** The reporter's written reason. */
  reason: string;
  /**
   * The IRI of the incoming ActivityPub `Flag` activity.  Omit for reports
   * submitted by local users.
   */
  iri?: string;
  /**
   * Whether the reporter opted in to forwarding this report to the remote
   * instance after moderator action.
   */
  forwardToRemote?: boolean;
}

/**
 * Files a report: finds or creates the open case for the target, inserts
 * the flag, captures a content snapshot as evidence, and notifies
 * moderators.
 *
 * Returns `undefined` when the report is invalid (self-report, a post that
 * does not belong to the target actor, or a too-short reason from a local
 * reporter) or a duplicate (same reporter already has an open report on the
 * case, or the `Flag` activity was already processed).
 */
export async function createFlag(
  db: Database,
  options: CreateFlagOptions,
): Promise<
  (Flag & { case: FlagCase; snapshot: ContentSnapshot }) | undefined
> {
  const { reporter, targetActor, targetPost } = options;
  const reason = options.reason.trim();
  if (reporter.id === targetActor.id) {
    logger.debug(
      "Rejecting self-report from actor {actorId}.",
      { actorId: reporter.id },
    );
    return undefined;
  }
  if (targetPost != null && targetPost.actorId !== targetActor.id) {
    logger.debug(
      "Rejecting report: post {postId} does not belong to actor {actorId}.",
      { postId: targetPost.id, actorId: targetActor.id },
    );
    return undefined;
  }
  if (options.iri == null && reason.length < MIN_REPORT_REASON_LENGTH) {
    logger.debug("Rejecting report with too short a reason.");
    return undefined;
  }
  if (options.iri != null) {
    const existing = await getFlagByIri(db, options.iri);
    if (existing != null) {
      logger.debug(
        "Ignoring already-processed Flag activity {iri}.",
        { iri: options.iri },
      );
      return undefined;
    }
  }
  const cocVersion = await getCocVersion();
  // All writes happen in one transaction so a failure halfway (e.g. while
  // capturing the snapshot) cannot leave a report without its evidence,
  // and so the FOR UPDATE lock taken when joining an existing open case
  // keeps the case open until the report is attached.
  const run = async (tx: Transaction) => {
    const flagCase = await findOrCreateOpenCase(tx, targetActor, targetPost);
    const flagRows = await tx.insert(flagTable)
      .values({
        id: generateUuidV7(),
        iri: options.iri,
        reporterId: reporter.id,
        targetActorId: targetActor.id,
        targetPostId: targetPost?.id,
        targetPostIri: targetPost?.iri,
        reason,
        cocVersion,
        caseId: flagCase.id,
        // A report follows its case's status: one joining a case already
        // under review starts as `reviewing`, not the default `pending`.
        status: flagCase.status,
        forwardToRemote: options.forwardToRemote ?? false,
      })
      .onConflictDoNothing()
      .returning();
    if (flagRows.length < 1) {
      logger.debug(
        "Duplicate report by actor {actorId} on case {caseId}.",
        { actorId: reporter.id, caseId: flagCase.id },
      );
      return undefined;
    }
    const flag = flagRows[0];
    const snapshot = await captureContentSnapshot(
      tx,
      flag,
      targetActor,
      targetPost,
    );
    await createFlagReceivedNotifications(tx, flagCase);
    return { ...flag, case: flagCase, snapshot };
  };
  return isTransaction(db) ? await run(db) : await db.transaction(run);
}

/**
 * Looks up an already-processed incoming `Flag` activity by its IRI, used
 * to deduplicate redelivered activities.
 */
export function getFlagByIri(
  db: Database,
  iri: string,
): Promise<Flag | undefined> {
  return db.query.flagTable.findFirst({ where: { iri } });
}

async function findOrCreateOpenCase(
  tx: Transaction,
  targetActor: Actor,
  targetPost?: Post,
): Promise<FlagCase> {
  // Insert-then-select so concurrent first reports on the same target
  // cannot create two open cases: the partial unique indexes make the
  // losing insert a no-op, and the subsequent select finds the winner.
  // The select locks the open case row (FOR UPDATE) so it cannot be
  // resolved out from under us before the report is attached; the loop
  // retries the rare race where the conflicting open case is closed
  // between the insert and the select.
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await tx.insert(flagCaseTable)
      .values({
        id: generateUuidV7(),
        targetActorId: targetActor.id,
        targetPostId: targetPost?.id,
        targetPostIri: targetPost?.iri,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) return inserted[0];
    const [existing] = await tx.select()
      .from(flagCaseTable)
      .where(and(
        eq(flagCaseTable.targetActorId, targetActor.id),
        targetPost == null
          ? isNull(flagCaseTable.targetPostIri)
          : eq(flagCaseTable.targetPostIri, targetPost.iri),
        inArray(flagCaseTable.status, ["pending", "reviewing"]),
      ))
      .for("update");
    if (existing != null) return existing;
  }
  throw new Error("Failed to find or create an open flag case.");
}

async function captureContentSnapshot(
  db: Database,
  flag: Flag,
  targetActor: Actor,
  targetPost?: Post,
): Promise<ContentSnapshot> {
  let metadata: ContentSnapshotMetadata = {
    actorHandle: targetActor.handle,
    actorName: targetActor.name ?? undefined,
    actorAvatarUrl: targetActor.avatarUrl ?? undefined,
  };
  let sourceContent: string | undefined;
  if (targetPost != null) {
    const media = await db.query.postMediumTable.findMany({
      where: { postId: targetPost.id },
      orderBy: { index: "asc" },
    });
    metadata = {
      ...metadata,
      postType: targetPost.type,
      name: targetPost.name ?? undefined,
      summary: targetPost.summary ?? undefined,
      language: targetPost.language ?? undefined,
      visibility: targetPost.visibility,
      sensitive: targetPost.sensitive,
      mediaUrls: media.map((medium) => medium.url),
      published: targetPost.published.toISOString(),
    };
    sourceContent = await getPostSourceContent(db, targetPost);
  }
  const rows = await db.insert(contentSnapshotTable)
    .values({
      id: generateUuidV7(),
      flagId: flag.id,
      postId: targetPost?.id,
      postIri: targetPost?.iri,
      contentHtml: targetPost == null
        ? targetActor.bioHtml ?? ""
        : targetPost.contentHtml,
      sourceContent,
      metadata,
    })
    .returning();
  return rows[0];
}

async function getPostSourceContent(
  db: Database,
  post: Post,
): Promise<string | undefined> {
  if (post.noteSourceId != null) {
    const noteSource = await db.query.noteSourceTable.findFirst({
      where: { id: post.noteSourceId },
      columns: { content: true },
    });
    return noteSource?.content;
  }
  if (post.articleSourceId != null) {
    const contents = await db.query.articleContentTable.findMany({
      where: {
        sourceId: post.articleSourceId,
        originalLanguage: { isNull: true },
      },
      columns: { language: true, content: true },
    });
    if (contents.length < 1) return undefined;
    const matching = contents.find((c) => c.language === post.language);
    return (matching ?? contents[0]).content;
  }
  return undefined;
}

/**
 * Runs the LLM code of conduct matching for a freshly filed report and
 * stores the result in `flag.llmAnalysis`.
 *
 * This is a fire-and-forget step: callers invoke it *after* the report's
 * transaction commits (`void analyzeFlag(...).catch(...)`), on the root
 * database handle, so a slow or failing LLM call can never block or roll
 * back report creation.  Failures are recorded in the stored analysis
 * (`error` set, no matches) so the moderation dashboard can distinguish
 * "analysis failed" from "analysis pending".
 *
 * The result is a reference for moderators, never an automated decision.
 */
export async function analyzeFlag(
  db: Database,
  aiServices: Pick<AiServices, "analyzeFlaggedContent">,
  model: ApplicationModel,
  flag: Flag,
  snapshot: ContentSnapshot,
): Promise<void> {
  const modelId = model.id;
  let analysis: FlagLlmAnalysis;
  try {
    const provisions = await getCocProvisions("en");
    const result = await aiServices.analyzeFlaggedContent({
      model,
      provisions,
      reason: flag.reason,
      contentHtml: snapshot.contentHtml,
      contentKind: snapshot.postId == null && snapshot.postIri == null
        ? "profile"
        : "post",
    });
    analysis = {
      matches: result.matches,
      summary: result.summary,
      model: modelId,
      analyzed: new Date().toISOString(),
    };
  } catch (error) {
    logger.warn(
      "Code of conduct analysis for flag {flagId} failed: {error}",
      { flagId: flag.id, error },
    );
    analysis = {
      matches: [],
      summary: "",
      model: modelId,
      analyzed: new Date().toISOString(),
      error: String(error),
    };
  }
  await db.update(flagTable)
    .set({ llmAnalysis: analysis, updated: new Date() })
    .where(eq(flagTable.id, flag.id));
}
