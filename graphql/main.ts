// Must be the first import — see instrument.ts for the rationale.
import "./instrument.ts";

import { getXForwardedRequest } from "@hongminhee/x-forwarded-fetch";
import { getLogger } from "@logtape/logtape";
import { recomputeNewsScores } from "@hackerspub/models/news";
import * as models from "./ai.ts";
import { db } from "./db.ts";
import { drive } from "./drive.ts";
import { transport as email } from "./email.ts";
import { federation } from "./federation.ts";
import { kv } from "./kv.ts";
import { createYogaServer } from "./mod.ts";
import { handleMediumUploadProxy } from "./medium-upload.ts";
import assetlinks from "./static/.well-known/assetlinks.json" with {
  type: "json",
};
const appleAppSiteAssociationJson = Deno.readTextFileSync(
  new URL("./static/.well-known/apple-app-site-association", import.meta.url),
);

const yogaServer = createYogaServer();

// Periodic news-score sweep.  The write hook re-scores a link only when the
// link itself is (un)shared, so engagement-driven re-ranking (a new reply,
// quote, or reaction on an existing story) relies on this sweep.  It recomputes
// links with any activity since the window, derived from source timestamps.
// The moderator "recompute" mutation is the authoritative full rebuild and
// reconciles anything the incremental/sweep paths miss.  Scoped to
// `activeSince` to bound cost; idempotent, so a multi-replica double-fire is
// wasteful but harmless.  Lives here in the server entry point (not in
// `mod.ts`) so codegen and tests never register it.
const newsLogger = getLogger(["hackerspub", "graphql", "news"]);
const NEWS_SWEEP_ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
Deno.cron("recompute-news-scores", "*/5 * * * *", async () => {
  try {
    const activeSince = new Date(Date.now() - NEWS_SWEEP_ACTIVE_WINDOW_MS);
    const result = await recomputeNewsScores(db, { activeSince });
    newsLogger.debug("News score sweep updated {linksUpdated} link(s).", {
      linksUpdated: result.linksUpdated,
    });
  } catch (error) {
    newsLogger.error("News score sweep failed: {error}", { error });
  }
});

Deno.serve({ port: 8080 }, async (req, info) => {
  try {
    req = await getXForwardedRequest(req);
    const url = new URL(req.url);
    const disk = drive.use();
    const uploadResponse = await handleMediumUploadProxy(req, kv, disk);
    if (uploadResponse != null) return uploadResponse;
    if (url.pathname === "/.well-known/assetlinks.json") {
      return new Response(JSON.stringify(assetlinks), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/.well-known/apple-app-site-association") {
      return new Response(appleAppSiteAssociationJson, {
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.pathname.startsWith("/.well-known/") ||
      url.pathname.startsWith("/ap/") ||
      url.pathname.startsWith("/nodeinfo/")
    ) {
      return await federation.fetch(req, {
        contextData: { db, kv, disk, models },
      });
    }
    return await yogaServer.fetch(req, {
      altTextGenerator: models.altTextGenerator,
      db,
      kv,
      disk,
      email,
      fedCtx: federation.createContext(req, { db, kv, disk, models }),
      request: req,
      connectionInfo: info,
    });
  } catch (e) {
    // Client disconnected before the server finished — not a server error.
    if (e instanceof DOMException && e.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    throw e;
  }
});
