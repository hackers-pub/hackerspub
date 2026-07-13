// Must be the first import — see instrument.ts for the rationale.
import "./instrument.ts";
import "./logging.ts";

import { getXForwardedRequest } from "@hongminhee/x-forwarded-fetch";
import { toApplicationContext } from "@hackerspub/federation/context";
import {
  getDenoEnvironment,
  loadServerConfig,
} from "@hackerspub/runtime/config";
import { createRuntimeResources } from "@hackerspub/runtime/resources";
import { createYogaServer } from "./mod.ts";
import { handleMediumUploadProxy } from "./medium-upload.ts";
import { services } from "./services.ts";
import assetlinks from "./static/.well-known/assetlinks.json" with {
  type: "json",
};
import metadata from "./deno.json" with { type: "json" };
const appleAppSiteAssociationJson = Deno.readTextFileSync(
  new URL("./static/.well-known/apple-app-site-association", import.meta.url),
);

const yogaServer = createYogaServer();
const resources = await createRuntimeResources(
  loadServerConfig(getDenoEnvironment()),
  metadata.version,
  {
    fileSystemBaseUrl: new URL("./", import.meta.url),
    federation: { manuallyStartQueue: true },
  },
);
const { db, drive, email, federation, kv, models } = resources;

// The federation inbox/outbox queue worker and the periodic news-score sweep
// run in a separate process (`worker.ts`), not here: keeping that background
// work off this event loop and DB pool is what stops it from starving
// user-facing GraphQL requests into Caddy 504s (WEB-NEXT-1W).
const server = Deno.serve({ port: 8080 }, async (req, info) => {
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
        contextData: { db, kv, disk, models, services },
      });
    }
    return await yogaServer.fetch(req, {
      altTextGenerator: models.altTextGenerator,
      db,
      kv,
      disk,
      email,
      emailFrom: resources.config.email.from,
      fedCtx: toApplicationContext(
        federation.createContext(req, {
          db,
          kv,
          disk,
          models,
          services,
        }),
      ),
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => server.shutdown());
}
await server.finished;
await resources.close();
