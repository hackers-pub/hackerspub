import { getNodeInfo } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import { isActor } from "@fedify/vocab";
import type { Actor as FedifyActor } from "@fedify/vocab";
import { validateUuid } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { Actor } from "./actor.ts";
import { builder, type UserContext } from "./builder.ts";

const logger = getLogger(["hackerspub", "graphql", "webfinger"]);

const FEDIVERSE_ID_REGEX =
  /^@?([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;

interface WebfingerLink {
  rel?: string;
  type?: string;
  href?: string;
  template?: string;
}

interface WebFingerResultData {
  preferredUsername: string | null;
  name: string | null;
  summary: string | null;
  url: URL | null;
  iconUrl: URL | null;
  handle: string | null;
  domain: string | null;
  software: string | null;
  emojis: Record<string, string> | null;
  remoteFollowUrl: URL | null;
}

const WebFingerResult = builder.simpleObject("WebFingerResult", {
  description: "Result of looking up a remote follower via WebFinger, " +
    "including their ActivityPub profile and remote follow URL.",
  fields: (t) => ({
    preferredUsername: t.string({ nullable: true }),
    name: t.string({ nullable: true }),
    summary: t.string({ nullable: true }),
    url: t.field({ type: "URL", nullable: true }),
    iconUrl: t.field({ type: "URL", nullable: true }),
    handle: t.string({ nullable: true }),
    domain: t.string({ nullable: true }),
    software: t.string({ nullable: true }),
    emojis: t.field({ type: "JSON", nullable: true }),
    remoteFollowUrl: t.field({ type: "URL", nullable: true }),
  }),
});

async function buildWebFingerResult(
  actorObject: FedifyActor,
  normalizedId: string,
  domain: string,
  remoteFollowUrl?: URL,
): Promise<WebFingerResultData> {
  let software = "unknown";
  try {
    const nodeInfo = await getNodeInfo(`https://${domain}`);
    if (nodeInfo?.software?.name) {
      software = nodeInfo.software.name.toLowerCase();
    }
  } catch (error) {
    logger.warn("Failed to get nodeinfo for {domain}: {error}", {
      domain,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let iconUrl: URL | null = null;
  const icon = await actorObject.getIcon();
  if (icon) {
    const raw = icon.url instanceof URL
      ? icon.url.href
      : icon.url?.href?.href ?? null;
    if (raw) iconUrl = new URL(raw);
  }
  if (!iconUrl && actorObject.iconId) {
    iconUrl = new URL(actorObject.iconId.href);
  }

  const emojis: Record<string, string> = {};
  try {
    for await (const tag of actorObject.getTags()) {
      if (!(tag instanceof vocab.Emoji)) continue;
      try {
        if (tag.name == null) continue;
        const emojiIcon = await tag.getIcon();
        if (
          emojiIcon?.url == null ||
          emojiIcon.url instanceof vocab.Link && emojiIcon.url.href == null
        ) {
          continue;
        }
        const emojiName = tag.name.toString();
        const raw = emojiIcon.url instanceof vocab.Link
          ? emojiIcon.url.href!.href
          : emojiIcon.url.href;
        const u = new URL(raw);
        if (
          (u.protocol === "http:" || u.protocol === "https:") &&
          !/[\'\"]/.test(raw)
        ) {
          emojis[emojiName] = u.href;
        }
      } catch (error) {
        logger.warn("Failed to extract emoji {name}: {error}", {
          name: tag.name?.toString() ?? "unknown",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    logger.warn("Failed to iterate tags: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    preferredUsername: actorObject.preferredUsername?.toString() ?? null,
    name: actorObject.name?.toString() ?? null,
    summary: actorObject.summary?.toString() ?? null,
    url: actorObject.url instanceof URL
      ? actorObject.url
      : actorObject.url?.toString()
      ? new URL(actorObject.url.toString())
      : null,
    iconUrl,
    handle: normalizedId,
    domain,
    software,
    emojis: Object.keys(emojis).length > 0 ? emojis : null,
    remoteFollowUrl: remoteFollowUrl ?? null,
  };
}

async function lookupRemoteFollowerImpl(
  ctx: UserContext,
  followerHandle: string,
  actorHandle: string,
): Promise<WebFingerResultData | null> {
  const match = followerHandle.trim().match(FEDIVERSE_ID_REGEX);
  if (!match) return null;

  const [, username, domain] = match;
  const normalizedId = `${username}@${domain}`;

  logger.info("Looking up remote follower {followerHandle}", {
    followerHandle: normalizedId,
  });

  const webfingerResult = await ctx.fedCtx.lookupWebFinger(
    `acct:${normalizedId}`,
  );
  if (webfingerResult == null) return null;

  const activityPubLink = webfingerResult.links?.find((link) =>
    link.rel === "self" &&
    (link.type === "application/activity+json" ||
      link.type?.startsWith(
        'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      ))
  ) as WebfingerLink | undefined;

  if (!activityPubLink?.href) return null;

  const remoteFollowLink = webfingerResult.links?.find((link) =>
    link.rel === "http://ostatus.org/schema/1.0/subscribe"
  ) as WebfingerLink | undefined;

  let remoteFollowUrl: URL | undefined;
  if (remoteFollowLink?.template?.includes("{uri}")) {
    const candidate = remoteFollowLink.template.replace(
      "{uri}",
      encodeURIComponent(actorHandle),
    );
    try {
      const u = new URL(candidate);
      if (u.protocol === "http:" || u.protocol === "https:") {
        remoteFollowUrl = u;
      }
    } catch {
      // invalid URL template, ignore
    }
  }

  try {
    const documentLoader = ctx.account == null
      ? ctx.fedCtx.documentLoader
      : await ctx.fedCtx.getDocumentLoader({ identifier: ctx.account.id });

    const actorObject = await ctx.fedCtx.lookupObject(activityPubLink.href, {
      documentLoader,
    });

    if (!isActor(actorObject)) {
      throw new Error("Object is not an actor");
    }

    return await buildWebFingerResult(
      actorObject,
      normalizedId,
      domain,
      remoteFollowUrl,
    );
  } catch (error) {
    logger.warn(
      "ActivityPub lookup failed, using fallback: {error}",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );

    return {
      preferredUsername: username,
      name: username,
      summary: null,
      url: new URL(activityPubLink.href),
      iconUrl: null,
      handle: normalizedId,
      domain,
      software: "unknown",
      emojis: null,
      remoteFollowUrl: remoteFollowUrl ?? null,
    };
  }
}

builder.queryFields((t) => ({
  lookupRemoteFollower: t.field({
    description: "Look up a remote Fediverse user by their handle, " +
      "fetching their ActivityPub profile and constructing " +
      "a remote follow URL for the given actor.",
    type: WebFingerResult,
    nullable: true,
    args: {
      followerHandle: t.arg.string({
        required: true,
        description:
          "The Fediverse handle of the remote user who wants to follow " +
          "(e.g., @user@mastodon.social).",
      }),
      actorId: t.arg.globalID({
        required: true,
        for: [Actor],
        description:
          "The Relay global ID of the Hackers' Pub actor to be followed.",
      }),
    },
    async resolve(_, args, ctx) {
      try {
        if (
          args.actorId.typename !== "Actor" ||
          !validateUuid(args.actorId.id)
        ) {
          return null;
        }

        const actor = await ctx.db.query.actorTable.findFirst({
          where: { id: args.actorId.id },
          columns: { handle: true },
        });

        if (!actor) return null;

        return await lookupRemoteFollowerImpl(
          ctx,
          args.followerHandle,
          actor.handle,
        );
      } catch (error) {
        logger.error("Remote follower lookup error: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  }),
}));
