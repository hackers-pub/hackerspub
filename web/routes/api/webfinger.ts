import { type Actor, getNodeInfo, isActor } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { define } from "../../utils.ts";
import getFixedT from "../../i18n.ts";
import type { Language } from "../../i18n.ts";

// WebFinger Link interface based on RFC 7033 with template extension
interface WebfingerLink {
  rel?: string;
  type?: string;
  href?: string;
  template?: string;
}

interface WebfingerRequest {
  fediverseId: string;
  language?: Language;
  actorHandle?: string;
}

export interface ActorInfo {
  id?: string;
  type?: string;
  preferredUsername?: string;
  name?: string;
  summary?: string;
  url?: string;
  icon: string | null;
  image: string | null;
  handle?: string;
  profileUrl?: string;
  domain?: string;
  software?: string;
  emojis?: Record<string, string>;
}

// Constants
const FEDIVERSE_ID_REGEX = /^@?([^@]+)@([^@]+)$/;
const ACTIVITY_PUB_TYPE = "application/activity+json";

// Helper functions
function createJsonResponse(data: unknown, status: number): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

const logger = getLogger(["hackerspub", "api", "webfinger"]);

function validateFediverseId(
  fediverseId: unknown,
  t: ReturnType<typeof getFixedT>,
): { isValid: false; error: string } | {
  isValid: true;
  username: string;
  domain: string;
} {
  if (!fediverseId || typeof fediverseId !== "string") {
    return { isValid: false, error: t("remoteFollow.api.fediverseIdRequired") };
  }

  const match = fediverseId.trim().match(FEDIVERSE_ID_REGEX);
  if (!match) {
    return {
      isValid: false,
      error: t("remoteFollow.api.fediverseIdInvalidFormat"),
    };
  }

  const [, username, domain] = match;
  return { isValid: true, username, domain };
}

async function buildActorInfo(
  actorObject: Actor,
  finalNormalizedId: string,
  finalDomain: string,
  profileUrl: string,
): Promise<ActorInfo> {
  let software = "unknown";
  try {
    const nodeInfo = await getNodeInfo(`https://${finalDomain}`);
    if (nodeInfo?.software?.name) {
      software = nodeInfo.software.name.toLowerCase();
    }
  } catch (error) {
    logger.warn("Failed to get nodeinfo for {domain}: {error}", {
      domain: finalDomain,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let iconUrl = null;
  let imageUrl = null;

  const icon = await actorObject.getIcon();
  if (icon) {
    iconUrl = icon.url?.href;
  }

  const image = await actorObject.getImage();
  if (image) {
    imageUrl = image.url?.href;
  }

  // fallback access
  if (!iconUrl && actorObject.iconId) {
    iconUrl = actorObject.iconId.href;
  }
  if (!imageUrl && actorObject.imageId) {
    imageUrl = actorObject.imageId.href;
  }
  // Extract custom emojis
  const emojis: Record<string, string> = {};
  try {
    for await (const tag of actorObject.getTags()) {
      if (tag instanceof vocab.Emoji) {
        if (tag.name == null) continue;
        const icon = await tag.getIcon();
        if (
          icon?.url == null ||
          icon.url instanceof vocab.Link && icon.url.href == null
        ) {
          continue;
        }
        const emojiName = tag.name.toString();
        emojis[emojiName] = icon.url instanceof vocab.Link
          ? icon.url.href!.href
          : icon.url.href;
      }
    }
  } catch (error) {
    logger.warn("Failed to extract custom emojis: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    id: actorObject.id?.href,
    type: actorObject.constructor.name,
    preferredUsername: actorObject.preferredUsername?.toString(),
    name: actorObject.name?.toString(),
    summary: actorObject.summary?.toString(),
    url: actorObject.url instanceof URL
      ? actorObject.url.href
      : actorObject.url?.toString(),
    icon: iconUrl instanceof URL ? iconUrl.href : (iconUrl ?? null),
    image: imageUrl instanceof URL ? imageUrl.href : (imageUrl ?? null),
    handle: finalNormalizedId,
    profileUrl: profileUrl,
    domain: finalDomain,
    software: software,
    emojis: emojis,
  };
}

export const handler = define.handlers(async (ctx) => {
  const requestBody = await ctx.req.json() as WebfingerRequest;
  const { fedCtx, account } = ctx.state;
  const t = getFixedT(requestBody.language);

  try {
    // Validate Fediverse ID
    const validation = validateFediverseId(requestBody.fediverseId, t);
    if (!validation.isValid) {
      return createJsonResponse({ error: validation.error }, 400);
    }

    const { username, domain } = validation;
    const normalizedId = `${username}@${domain}`;

    logger.info("Looking up actor: {fediverseId}", {
      fediverseId: normalizedId,
    });

    const webfingerResult = await ctx.state.fedCtx.lookupWebFinger(
      `acct:${normalizedId}`,
    );

    if (webfingerResult === null) {
      return createJsonResponse(
        { error: t("remoteFollow.api.webfingerLookupError") },
        404,
      );
    }

    // Find ActivityPub and subscribe links
    const activityPubLink = webfingerResult.links?.find((link) =>
      link.type === ACTIVITY_PUB_TYPE ||
      (link.rel === "self" && link.type?.includes("activity"))
    ) as WebfingerLink | undefined;

    if (!activityPubLink || !activityPubLink.href) {
      logger.warn("No ActivityPub profile found for {fediverseId}", {
        fediverseId: normalizedId,
      });
      return createJsonResponse(
        { error: t("remoteFollow.api.activityPubProfileNotFound") },
        404,
      );
    }

    try {
      // Lookup ActivityPub object with signed request if account available
      const documentLoader = account == null
        ? fedCtx.documentLoader
        : await fedCtx.getDocumentLoader({ identifier: account.id });

      const actorObject = await fedCtx.lookupObject(activityPubLink.href, {
        documentLoader,
      });

      if (!isActor(actorObject)) {
        throw new Error(t("remoteFollow.api.objectNotActor"));
      }

      // Build actor information
      const actorInfo = await buildActorInfo(
        actorObject,
        normalizedId,
        domain,
        activityPubLink.href,
      );

      logger.info("Successfully looked up actor: {handle}", {
        handle: normalizedId,
      });

      return createJsonResponse({ actor: actorInfo }, 200);
    } catch (error) {
      logger.warn(
        "ActivityPub lookup failed, falling back to basic info: {error}",
        {
          error: error instanceof Error ? error.message : String(error),
          profileUrl: activityPubLink.href,
        },
      );

      const name = normalizedId.split("@")[0];
      // Fallback: create basic actor info from webfinger data only
      const actorInfo = {
        id: activityPubLink.href,
        type: "Person",
        preferredUsername: name,
        name,
        url: activityPubLink.href,
        icon: null,
        image: null,
        handle: normalizedId,
        profileUrl: activityPubLink.href,
        domain,
        software: "unknown",
      };

      logger.info("Using fallback actor info for: {handle}", {
        handle: normalizedId,
      });

      return createJsonResponse({ actor: actorInfo }, 200);
    }
  } catch (error) {
    logger.error("Webfinger API error: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });

    return createJsonResponse(
      { error: t("remoteFollow.api.serverError") },
      500,
    );
  }
});
