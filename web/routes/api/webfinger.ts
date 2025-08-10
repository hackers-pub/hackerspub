import { getNodeInfo, isActor } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { define } from "../../utils.ts";

const logger = getLogger(["hackerspub", "api", "webfinger"]);

export const handler = define.handlers(async (ctx) => {
  if (ctx.req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { fediverseId } = await ctx.req.json();
    const { fedCtx } = ctx.state;

    if (!fediverseId || typeof fediverseId !== "string") {
      return new Response(
        JSON.stringify({ error: "Fediverse ID가 필요합니다." }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const fediverseIdRegex =
      /^@?([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;
    const match = fediverseId.trim().match(fediverseIdRegex);

    if (!match) {
      return new Response(
        JSON.stringify({ error: "올바른 Fediverse ID 형식이 아닙니다." }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const [, username, domain] = match;
    const normalizedId = `${username}@${domain}`;

    // 개발 환경에서 도메인 변환 처리
    const getProductionHandle = (handle: string) => {
      // 개발 환경 감지 (서버 사이드에서는 환경변수나 다른 방법 사용)
      const isDevelopment = Deno.env.get("DENO_ENV") === "development" ||
        Deno.env.get("NODE_ENV") === "development";

      if (!isDevelopment) return handle;

      return handle
        .replace(/@[a-f0-9]+\.ngrok-free\.app$/, "@hackers.pub");
    };

    const productionHandle = getProductionHandle(`@${normalizedId}`);
    const finalNormalizedId = productionHandle.startsWith("@")
      ? productionHandle.slice(1)
      : productionHandle;

    logger.info("Looking up actor: {fediverseId} -> {finalId}", {
      fediverseId: normalizedId,
      finalId: finalNormalizedId,
    });

    // webfinger를 통한 사용자 조회 (변환된 ID 사용)
    const finalDomain = finalNormalizedId.split("@")[1];
    const webfingerUrl =
      `https://${finalDomain}/.well-known/webfinger?resource=acct:${finalNormalizedId}`;

    const webfingerResponse = await fetch(webfingerUrl, {
      headers: {
        "Accept": "application/jrd+json, application/json",
        "User-Agent": "HackersPub/1.0 (https://hackerspub.com/)",
      },
    });

    if (!webfingerResponse.ok) {
      logger.warn("Webfinger lookup failed: {status} {url}", {
        status: webfingerResponse.status,
        url: webfingerUrl,
      });
      return new Response(
        JSON.stringify({
          error: `사용자를 찾을 수 없습니다: ${webfingerResponse.status}`,
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const webfingerData = await webfingerResponse.json();

    const activityPubLink = webfingerData.links?.find((
      link: { type?: string; rel?: string; href?: string },
    ) =>
      link.type === "application/activity+json" ||
      (link.rel === "self" && link.type?.includes("activity"))
    );

    const subscribeLink = webfingerData.links?.find((
      link: { rel?: string; template?: string },
    ) => link.rel === "http://ostatus.org/schema/1.0/subscribe");

    if (!activityPubLink) {
      logger.warn("No ActivityPub profile found for {fediverseId}", {
        fediverseId: finalNormalizedId,
      });
      return new Response(
        JSON.stringify({ error: "ActivityPub 프로필을 찾을 수 없습니다." }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    try {
      const actorObject = await fedCtx.lookupObject(activityPubLink.href);

      if (!isActor(actorObject)) {
        throw new Error("조회된 객체가 Actor가 아닙니다.");
      }

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

      const actorInfo = {
        id: actorObject.id?.href,
        type: actorObject.constructor.name,
        preferredUsername: actorObject.preferredUsername,
        name: actorObject.name?.toString(),
        summary: actorObject.summary?.toString(),
        url: actorObject.url?.href,
        icon: iconUrl,
        image: imageUrl,
        handle: finalNormalizedId,
        profileUrl: activityPubLink.href,
        domain: finalDomain,
        software: software,
        template: subscribeLink?.template, // 원격 팔로우용 template 추가
      };

      logger.info("Successfully looked up actor: {handle}", {
        handle: finalNormalizedId,
      });

      return new Response(
        JSON.stringify({ actor: actorInfo }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      logger.error("Failed to lookup ActivityPub object: {error}", {
        error: error instanceof Error ? error.message : String(error),
        profileUrl: activityPubLink.href,
      });

      return new Response(
        JSON.stringify({ error: "프로필 정보를 가져올 수 없습니다." }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  } catch (error) {
    logger.error("Webfinger API error: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });

    return new Response(
      JSON.stringify({ error: "서버 오류가 발생했습니다." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});
