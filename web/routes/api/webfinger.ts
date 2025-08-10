import { type Actor, getNodeInfo, isActor } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { define } from "../../utils.ts";

interface WebfingerRequest {
  fediverseId: string;
  actorHandle?: string;
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
): { isValid: false; error: string } | {
  isValid: true;
  username: string;
  domain: string;
} {
  if (!fediverseId || typeof fediverseId !== "string") {
    return { isValid: false, error: "Fediverse ID가 필요합니다." };
  }

  const match = fediverseId.trim().match(FEDIVERSE_ID_REGEX);
  if (!match) {
    return { isValid: false, error: "올바른 Fediverse ID 형식이 아닙니다." };
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
        error: `사용자를 찾을 수 없습니다: ${response.status}`,
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
    return { success: false, error: "Webfinger 조회 중 오류가 발생했습니다." };
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
  if (ctx.req.method !== "POST") {
    return createJsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const requestBody = await ctx.req.json() as WebfingerRequest;
    const { fedCtx } = ctx.state;

    // Validate Fediverse ID
    const validation = validateFediverseId(requestBody.fediverseId);
    if (!validation.isValid) {
      return createJsonResponse({ error: validation.error }, 400);
    }

    const { username, domain } = validation;
    const normalizedId = `${username}@${domain}`;

    logger.info("Looking up actor: {fediverseId}", {
      fediverseId: normalizedId,
    });

    // Perform webfinger lookup
    const webfingerResult = await lookupWebfinger(
      domain,
      normalizedId,
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
        { error: "ActivityPub 프로필을 찾을 수 없습니다." },
        404,
      );
    }

    try {
      // Lookup ActivityPub object
      const actorObject = await fedCtx.lookupObject(activityPubLink.href);

      if (!isActor(actorObject)) {
        throw new Error("조회된 객체가 Actor가 아닙니다.");
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
        { error: "프로필 정보를 가져올 수 없습니다." },
        500,
      );
    }
  } catch (error) {
    logger.error("Webfinger API error: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });

    return createJsonResponse(
      { error: "서버 오류가 발생했습니다." },
      500,
    );
  }
});
