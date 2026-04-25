import process from "node:process";
import type { Context } from "@fedify/fedify";
import type { Recipient } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import type { PostVisibility } from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";

export const DEFAULT_TAGS_PUB_RELAY_ACTOR_ID: URL = new URL(
  "https://tags.pub/user/_____relay_____",
);
export const DEFAULT_TAGS_PUB_RELAY_INBOX_ID: URL = new URL(
  "https://tags.pub/user/_____relay_____/inbox",
);

export interface TagsPubRelayConfig {
  readonly enabled: boolean;
  readonly actorId?: URL;
  readonly inboxId?: URL;
}

export interface TagsPubRelayDecisionOptions {
  readonly config: TagsPubRelayConfig;
  readonly visibility: PostVisibility;
  readonly accountBio: string | null;
  readonly relayedTags?: readonly string[] | Record<string, string>;
}

export interface SendTagsPubRelayOptions
  extends Omit<TagsPubRelayDecisionOptions, "config"> {
  readonly orderingKey: string;
}

export interface TagsPubRelayDecision {
  readonly send: boolean;
  readonly relayedTags: readonly string[];
}

export function getTagsPubRelayConfig(
  env: Record<string, string | undefined> = process.env,
): TagsPubRelayConfig {
  const enabled = parseBooleanEnv(env.TAGS_PUB_RELAY);
  if (!enabled) return { enabled: false };

  const inboxId = env.TAGS_PUB_RELAY_INBOX_URL == null ||
      env.TAGS_PUB_RELAY_INBOX_URL.trim() === ""
    ? DEFAULT_TAGS_PUB_RELAY_INBOX_ID
    : new URL(env.TAGS_PUB_RELAY_INBOX_URL);
  const actorId = env.TAGS_PUB_RELAY_ACTOR_URL == null ||
      env.TAGS_PUB_RELAY_ACTOR_URL.trim() === ""
    ? defaultActorUrlFromInbox(inboxId)
    : new URL(env.TAGS_PUB_RELAY_ACTOR_URL);

  return { enabled: true, actorId, inboxId };
}

export function getTagsPubRelayRecipient(
  config: TagsPubRelayConfig,
): Recipient {
  if (!config.enabled || config.actorId == null || config.inboxId == null) {
    throw new TypeError("tags.pub relay integration is not enabled.");
  }
  return {
    id: config.actorId,
    inboxId: config.inboxId,
    endpoints: null,
  };
}

export function hasTagsPubOptOut(accountBio: string | null): boolean {
  if (accountBio == null) return false;
  return /(^|[^a-z0-9_])#(?:notagspub|nobots?|nobot)(?![a-z0-9_])/i.test(
    accountBio,
  );
}

export async function shouldSendToTagsPubRelay(
  activity: vocab.Activity,
  options: TagsPubRelayDecisionOptions,
): Promise<boolean> {
  return (await getTagsPubRelayDecision(activity, options)).send;
}

export async function getTagsPubRelayDecision(
  activity: vocab.Activity,
  options: TagsPubRelayDecisionOptions,
): Promise<TagsPubRelayDecision> {
  if (!options.config.enabled) return { send: false, relayedTags: [] };

  const relayedTags = normalizeRelayedTags(options.relayedTags);
  if (activity instanceof vocab.Delete) {
    return { send: relayedTags.length > 0, relayedTags: [] };
  }

  const currentTags = await getActivityHashtagNames(activity);
  if (relayedTags.length > 0) {
    if (
      hasTagsPubOptOut(options.accountBio) &&
      currentTags.some((tag) => !relayedTags.includes(tag))
    ) {
      return { send: false, relayedTags };
    }
    return { send: true, relayedTags: currentTags };
  }

  if (options.visibility !== "public") {
    return { send: false, relayedTags: [] };
  }

  if (hasTagsPubOptOut(options.accountBio)) {
    return { send: false, relayedTags: [] };
  }
  return { send: currentTags.length > 0, relayedTags: currentTags };
}

export async function sendTagsPubRelayActivity(
  ctx: Context<ContextData>,
  accountId: Uuid,
  activity: vocab.Activity,
  options: SendTagsPubRelayOptions,
): Promise<readonly string[] | undefined> {
  const config = getTagsPubRelayConfig();
  const decision = await getTagsPubRelayDecision(activity, {
    ...options,
    config,
  });
  if (!decision.send) return undefined;

  await ctx.sendActivity(
    { identifier: accountId },
    getTagsPubRelayRecipient(config),
    activity,
    {
      orderingKey: options.orderingKey,
      preferSharedInbox: false,
      excludeBaseUris: [
        new URL(ctx.origin),
        new URL(ctx.canonicalOrigin),
      ],
    },
  );
  return decision.relayedTags;
}

async function getActivityHashtagNames(
  activity: vocab.Activity,
): Promise<string[]> {
  const tags = new Set<string>();
  await addHashtags(tags, activity);

  for await (
    const object of activity.getObjects({
      suppressError: true,
      crossOrigin: "trust",
    })
  ) {
    await addHashtags(tags, object);
  }

  return [...tags];
}

async function addHashtags(
  tags: Set<string>,
  object: vocab.Object,
): Promise<void> {
  for await (
    const tag of object.getTags({
      suppressError: true,
      crossOrigin: "trust",
    })
  ) {
    if (!(tag instanceof vocab.Hashtag) || tag.name == null) continue;
    const name = tag.name.toString().trim().replace(/^#/, "").toLowerCase();
    if (name !== "") tags.add(name);
  }
}

function normalizeRelayedTags(
  tags: readonly string[] | Record<string, string> | undefined,
): string[] {
  if (tags == null) return [];
  const names = Array.isArray(tags) ? tags : Object.keys(tags);
  return names
    .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
    .filter((tag) => tag !== "");
}

function parseBooleanEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function defaultActorUrlFromInbox(inboxId: URL): URL {
  if (inboxId.href === DEFAULT_TAGS_PUB_RELAY_INBOX_ID.href) {
    return DEFAULT_TAGS_PUB_RELAY_ACTOR_ID;
  }
  return new URL(".", inboxId);
}
