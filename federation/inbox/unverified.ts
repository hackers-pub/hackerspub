import type { RequestContext, UnverifiedActivityReason } from "@fedify/fedify";
import { type Activity, Delete } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["hackerspub", "federation", "inbox", "unverified"]);

export function shouldAcknowledgeUnverifiedActivity(
  activity: Activity,
  reason: UnverifiedActivityReason,
): boolean {
  return activity instanceof Delete &&
    reason.type === "keyFetchError" &&
    "status" in reason.result &&
    reason.result.status === 410;
}

export function onUnverifiedActivity(
  _ctx: RequestContext<ContextData>,
  activity: Activity,
  reason: UnverifiedActivityReason,
): Response | void {
  if (!shouldAcknowledgeUnverifiedActivity(activity, reason)) return;
  const keyFetchError = reason as
    & Extract<
      UnverifiedActivityReason,
      { type: "keyFetchError" }
    >
    & { result: { status: number } };
  logger.info(
    "Acknowledging unverified Delete from gone actor to stop retries: " +
      "{actorId} ({keyId}, HTTP {status})",
    {
      actorId: activity.actorId?.href,
      keyId: keyFetchError.keyId.href,
      status: keyFetchError.result.status,
    },
  );
  return new Response(null, { status: 202 });
}
