import type { InboxContext } from "@fedify/fedify";
import type { Flag as FlagActivity } from "@fedify/vocab";
import {
  getPersistedActor,
  isFederationBlocked,
  persistActor,
} from "@hackerspub/models/actor";
import type { ContextData } from "@hackerspub/models/context";
import { analyzeFlag, createFlag, getFlagByIri } from "@hackerspub/models/flag";
import type { Actor, Post } from "@hackerspub/models/schema";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["hackerspub", "federation", "inbox", "flag"]);

/**
 * Handles an incoming ActivityPub `Flag` activity: a report forwarded by
 * another instance (typically by its moderation team via the instance
 * actor).
 *
 * The activity's objects are matched against *local* data only (post and
 * actor IRIs/URLs); nothing is dereferenced remotely, since a report is
 * only actionable here when its target already lives on this instance.
 * External reports carry less context and come from unknown moderation
 * cultures, so they enter the same case queue marked as external
 * (`Flag.iri` set), where moderators apply additional scrutiny.
 */
export async function onFlagged(
  fedCtx: InboxContext<ContextData>,
  flag: FlagActivity,
): Promise<void> {
  const { db } = fedCtx.data;
  if (flag.id == null || flag.actorId == null) {
    logger.debug("Ignoring a Flag activity without an id or actor.");
    return;
  }
  if (await getFlagByIri(db, flag.id.href) != null) {
    logger.debug(
      "Ignoring already-processed Flag activity {iri}.",
      { iri: flag.id.href },
    );
    return;
  }
  let reporter = await getPersistedActor(db, flag.actorId);
  if (reporter != null && isFederationBlocked(reporter)) {
    logger.debug(
      "Dropping Flag activity {iri} from federation-blocked actor.",
      { iri: flag.id.href },
    );
    return;
  }
  if (reporter == null) {
    const actorObject = await flag.getActor({
      ...fedCtx,
      suppressError: true,
    });
    if (actorObject == null) {
      logger.debug(
        "Cannot resolve the reporting actor of Flag activity {iri}.",
        { iri: flag.id.href },
      );
      return;
    }
    reporter = await persistActor(fedCtx, actorObject) ?? undefined;
    if (reporter == null) return;
  }
  // Match the flagged objects against local data.  A Flag usually carries
  // the reported actor's IRI plus zero or more post IRIs (Mastodon's
  // shape); the first matched post whose author is local makes this a
  // content report, otherwise a matched local actor makes it a user
  // (profile) report.
  let targetPost: (Post & { actor: Actor }) | undefined;
  let targetActor: Actor | undefined;
  for (const objectId of flag.objectIds) {
    const href = objectId.href;
    if (targetPost == null) {
      const post = await db.query.postTable.findFirst({
        where: { OR: [{ iri: href }, { url: href }] },
        with: { actor: true },
      });
      if (post != null) {
        if (post.actor.accountId != null) targetPost = post;
        continue;
      }
    }
    if (targetActor == null) {
      const actor = await db.query.actorTable.findFirst({
        where: { OR: [{ iri: href }, { url: href }] },
      });
      if (actor?.accountId != null) targetActor = actor;
    }
  }
  if (targetPost != null) targetActor = targetPost.actor;
  if (targetActor == null) {
    logger.debug(
      "Dropping Flag activity {iri}: no local target among its objects.",
      { iri: flag.id.href },
    );
    return;
  }
  const reason = flag.content?.toString() ?? flag.summary?.toString() ?? "";
  const created = await createFlag(db, {
    iri: flag.id.href,
    reporter,
    targetActor,
    targetPost,
    reason,
    forwardToRemote: false,
  });
  if (created == null) {
    logger.debug(
      "Flag activity {iri} did not produce a report (duplicate or invalid).",
      { iri: flag.id.href },
    );
    return;
  }
  logger.info(
    "Filed an external report {flagId} from {reporter} against {target}.",
    {
      flagId: created.id,
      reporter: reporter.handle,
      target: targetActor.handle,
    },
  );
  const analyzer = fedCtx.data.models.moderationAnalyzer;
  if (analyzer != null) {
    // Fire-and-forget; failures are recorded in flag.llmAnalysis.
    void analyzeFlag(db, analyzer, created, created.snapshot)
      .catch((error) => {
        logger.error(
          "Failed to analyze flag {flagId}: {error}",
          { flagId: created.id, error },
        );
      });
  }
}
