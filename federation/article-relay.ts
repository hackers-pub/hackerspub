import type { Context } from "@fedify/fedify";
import type { Recipient } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { toRecipient } from "@hackerspub/models/actor";
import type { ContextData } from "@hackerspub/models/context";
import { getAcceptedRelaySubscriptions } from "@hackerspub/models/relay";
import type { SendArticleRelayOptions } from "@hackerspub/models/services";
import type { Uuid } from "@hackerspub/models/uuid";
import { sendRelayActivityWithOutbox } from "./context.ts";
import {
  getTagsPubRelayConfig,
  getTagsPubRelayDecision,
  getTagsPubRelayRecipient,
  type TagsPubRelayConfig,
} from "./tags-pub.ts";

function deduplicateRelayRecipients(
  recipients: readonly Recipient[],
): Recipient[] {
  const byInbox = new Map<string, Recipient>();
  for (const recipient of recipients) {
    if (recipient.inboxId == null) continue;
    byInbox.set(recipient.inboxId.href, recipient);
  }
  return [...byInbox.values()];
}

/**
 * Sends an initial public Article `Create` to accepted LitePub relays and the
 * optional tags.pub relay. Exact inbox duplicates are delivered only once.
 */
export async function sendArticleRelayActivity(
  ctx: Context<ContextData>,
  accountId: Uuid,
  activity: vocab.Activity,
  options: SendArticleRelayOptions,
  tagsPubConfig: TagsPubRelayConfig = getTagsPubRelayConfig(),
): Promise<readonly string[] | undefined> {
  if (!(activity instanceof vocab.Create)) return undefined;

  const tagsPubDecision = await getTagsPubRelayDecision(activity, {
    ...options,
    config: tagsPubConfig,
  });
  const subscriptions =
    options.visibility === "public"
      ? await getAcceptedRelaySubscriptions(ctx.data.db)
      : [];
  const recipients = subscriptions.map((subscription) =>
    toRecipient(subscription.actor),
  );
  if (tagsPubDecision.send) {
    recipients.push(getTagsPubRelayRecipient(tagsPubConfig));
  }
  const uniqueRecipients = deduplicateRelayRecipients(recipients);
  if (uniqueRecipients.length < 1) return undefined;

  await sendRelayActivityWithOutbox(
    ctx,
    { identifier: accountId },
    uniqueRecipients,
    activity,
    {
      orderingKey: options.orderingKey,
      preferSharedInbox: false,
      excludeBaseUris: [new URL(ctx.origin), new URL(ctx.canonicalOrigin)],
    },
  );
  return tagsPubDecision.send ? tagsPubDecision.relayedTags : undefined;
}
