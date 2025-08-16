import { type Actor, getNodeInfo, isActor } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { define } from "../../utils.ts";
import getFixedT from "../../i18n.ts";
import type { Language } from "../../i18n.ts";

interface WebfingerRequest {
  fediverseId: string;
  actorHandle?: string;
  language?: Language;
}

interface WebfingerLink {
  rel?: string;
  type?: string;
  href?: string;
  template?: string;
}

interface WebfingerResponse {
  subject: string;
  links: WebfingerLink[];
}

export interface ActorInfo {
  id: string | undefined;
  type: string;
  preferredUsername: string | undefined;
  name: string | undefined;
  summary: string | undefined;
  url: string | undefined;
  icon: string | null;
  image: string | null;
  handle: string;
  profileUrl: string;
  domain: string;
  software: string;
  template: string | undefined;
}

// Constants
const FEDIVERSE_ID_REGEX =
  /^@?([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;
const USER_AGENT = "HackersPub/1.0 (https://hackerspub.com/)";
const ACTIVITY_PUB_TYPE = "application/activity+json";
const OSTATUS_SUBSCRIBE_REL = "http://ostatus.org/schema/1.0/subscribe";
const WEBFINGER_ACCEPT_HEADER = "application/jrd+json, application/json";

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

function getProductionHandle(handle: string): string {
  const isDevelopment = Deno.env.get("MODE") === "development";
  const productionHandle = Deno.env.get("PRODUCTION_ACTOR_HANDLE");

  if (!isDevelopment || !productionHandle) return handle;

  return productionHandle;
}

async function lookupWebfinger(
  domain: string,
  normalizedId: string,
  t: ReturnType<typeof getFixedT>,
): Promise<
  {
    success: boolean;
    data?: WebfingerResponse;
    error?: string;
    status?: number;
  }
> {
  const webfingerUrl =
    `https://${domain}/.well-known/webfinger?resource=acct:${normalizedId}`;

  try {
    const response = await fetch(webfingerUrl, {
      headers: {
        "Accept": WEBFINGER_ACCEPT_HEADER,
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      logger.warn("Webfinger lookup failed: {status} {url}", {
        status: response.status,
        url: webfingerUrl,
      });
      return {
        success: false,
        error: t("remoteFollow.api.userNotFoundWithStatus", {
          status: response.status,
        }),
        status: response.status,
      };
    }

    const data = await response.json() as WebfingerResponse;
    return { success: true, data };
  } catch (error) {
    logger.error("Webfinger fetch error: {error}", {
      error: error instanceof Error ? error.message : String(error),
      url: webfingerUrl,
    });
    return {
      success: false,
      error: t("remoteFollow.api.webfingerLookupError"),
    };
  }
}

async function buildActorInfo(
  actorObject: Actor,
  finalNormalizedId: string,
  finalDomain: string,
  profileUrl: string,
  subscribeTemplate?: string,
  actorHandle?: string,
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

  // Handle development environment domain conversion for my actor handle
  const finalActorHandle = actorHandle
    ? getProductionHandle(actorHandle)
    : undefined;

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
    template: subscribeTemplate && finalActorHandle
      ? subscribeTemplate.replace("{uri}", encodeURIComponent(finalActorHandle))
      : subscribeTemplate,
  };
}

export const handler = define.handlers(async (ctx) => {
  const requestBody = await ctx.req.json() as WebfingerRequest;
  const { fedCtx } = ctx.state;
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

    const webfingerResult = await lookupWebfinger(
      domain,
      normalizedId,
      t,
    );

    if (!webfingerResult.success) {
      return createJsonResponse(
        { error: webfingerResult.error },
        webfingerResult.status || 404,
      );
    }

    const webfingerData = webfingerResult.data!;

    // Find ActivityPub and subscribe links
    const activityPubLink = webfingerData.links?.find((
      link: WebfingerLink,
    ) =>
      link.type === ACTIVITY_PUB_TYPE ||
      (link.rel === "self" && link.type?.includes("activity"))
    );

    const subscribeLink = webfingerData.links?.find((
      link: WebfingerLink,
    ) => link.rel === OSTATUS_SUBSCRIBE_REL);

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
      // Lookup ActivityPub object
      const actorObject = await fedCtx.lookupObject(activityPubLink.href);

      if (!isActor(actorObject)) {
        throw new Error(t("remoteFollow.api.objectNotActor"));
      }

      // Build actor information
      const actorInfo = await buildActorInfo(
        actorObject,
        normalizedId,
        domain,
        activityPubLink.href,
        subscribeLink?.template,
        requestBody.actorHandle,
      );

      logger.info("Successfully looked up actor: {handle}", {
        handle: normalizedId,
      });

      return createJsonResponse({ actor: actorInfo }, 200);
    } catch (error) {
      logger.error("Failed to lookup ActivityPub object: {error}", {
        error: error instanceof Error ? error.message : String(error),
        profileUrl: activityPubLink.href,
      });

      return createJsonResponse(
        { error: t("remoteFollow.api.profileInfoFetchFailed") },
        500,
      );
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
