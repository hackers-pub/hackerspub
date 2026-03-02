import { getNodeInfo } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import { type Actor, isActor } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
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

const WebFingerResult = builder.simpleObject("WebFingerResult", {
  fields: (t) => ({
    preferredUsername: t.string({ nullable: true }),
    name: t.string({ nullable: true }),
    summary: t.string({ nullable: true }),
    url: t.string({ nullable: true }),
    iconUrl: t.string({ nullable: true }),
    handle: t.string({ nullable: true }),
    domain: t.string({ nullable: true }),
    software: t.string({ nullable: true }),
    emojis: t.field({ type: "JSON", nullable: true }),
    remoteFollowUrl: t.string({ nullable: true }),
  }),
});

async function buildWebFingerResult(
  actorObject: Actor,
  normalizedId: string,
  domain: string,
  remoteFollowUrl?: string,
): Promise<{
  preferredUsername: string | null;
  name: string | null;
  summary: string | null;
  url: string | null;
  iconUrl: string | null;
  handle: string | null;
  domain: string | null;
  software: string | null;
  emojis: Record<string, string> | null;
  remoteFollowUrl: string | null;
}> {
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

  let iconUrl: string | null = null;
  const icon = await actorObject.getIcon();
  if (icon) {
    iconUrl = icon.url instanceof URL
      ? icon.url.href
      : icon.url?.href?.href ?? null;
  }
  if (!iconUrl && actorObject.iconId) {
    iconUrl = actorObject.iconId.href;
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
      ? actorObject.url.href
      : actorObject.url?.toString() ?? null,
    iconUrl,
    handle: normalizedId,
    domain,
    software,
    emojis: Object.keys(emojis).length > 0 ? emojis : null,
    remoteFollowUrl: remoteFollowUrl ?? null,
  };
}

async function lookupWebFingerImpl(
  ctx: UserContext,
  fediverseId: string,
  actorHandle: string,
) {
  const match = fediverseId.trim().match(FEDIVERSE_ID_REGEX);
  if (!match) return null;

  const [, username, domain] = match;
  const normalizedId = `${username}@${domain}`;

  logger.info("Looking up WebFinger for {fediverseId}", {
    fediverseId: normalizedId,
  });

  const webfingerResult = await ctx.fedCtx.lookupWebFinger(
    `acct:${normalizedId}`,
  );
  if (webfingerResult == null) return null;

  const activityPubLink = webfingerResult.links?.find((link) =>
    link.type === "application/activity+json" ||
    (link.rel === "self" && link.type?.includes("activity"))
  ) as WebfingerLink | undefined;

  if (!activityPubLink?.href) return null;

  const remoteFollowLink = webfingerResult.links?.find((link) =>
    link.rel === "http://ostatus.org/schema/1.0/subscribe"
  ) as WebfingerLink | undefined;

  let remoteFollowUrl: string | undefined;
  if (remoteFollowLink?.template?.includes("{uri}")) {
    const candidate = remoteFollowLink.template.replace(
      "{uri}",
      encodeURIComponent(actorHandle),
    );
    try {
      const u = new URL(candidate);
      if (u.protocol === "http:" || u.protocol === "https:") {
        remoteFollowUrl = u.toString();
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
      url: activityPubLink.href,
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
  lookupWebFinger: t.field({
    type: WebFingerResult,
    nullable: true,
    args: {
      fediverseId: t.arg.string({ required: true }),
      actorHandle: t.arg.string({ required: true }),
    },
    async resolve(_, args, ctx) {
      try {
        return await lookupWebFingerImpl(
          ctx,
          args.fediverseId,
          args.actorHandle,
        );
      } catch (error) {
        logger.error("WebFinger lookup error: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  }),
}));
