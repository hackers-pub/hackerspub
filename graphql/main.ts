// Must be the first import — see instrument.ts for the rationale.
import "./instrument.ts";
import "./logging.ts";

import { toApplicationContext } from "@hackerspub/federation/context";
import {
  getDenoEnvironment,
  loadServerConfig,
} from "@hackerspub/runtime/config";
import { createRuntimeResources } from "@hackerspub/runtime/resources";
import { handleFileSystemMedia } from "./file-system-media.ts";
import { createYogaServer } from "./mod.ts";
import { handleMediumUploadProxy } from "./medium-upload.ts";
import { services } from "./services.ts";
import { applyTrustedForwarding } from "./trusted-forwarding.ts";
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
const fileSystemRoot = drive.fileSystemRoot;

// The federation inbox/outbox queue worker and the periodic news-score sweep
// run in a separate process (`worker.ts`), not here: keeping that background
// work off this event loop and DB pool is what stops it from starving
// user-facing GraphQL requests into Caddy 504s (WEB-NEXT-1W).
const startServer = () =>
  Deno.serve({ port: 8080 }, async (req, info) => {
    try {
      const forwarded = await applyTrustedForwarding(
        req,
        info,
        resources.config.behindProxy,
      );
      req = forwarded.request;
      const url = new URL(req.url);
      const disk = drive.use();
      const uploadResponse = await handleMediumUploadProxy(req, kv, disk);
      if (uploadResponse != null) return uploadResponse;
      const mediaResponse = await handleFileSystemMedia(req, fileSystemRoot);
      if (mediaResponse != null) return mediaResponse;
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
        connectionInfo: forwarded.connectionInfo,
      });
    } catch (e) {
      // Client disconnected before the server finished — not a server error.
      if (e instanceof DOMException && e.name === "AbortError") {
        return new Response(null, { status: 499 });
      }
      throw e;
    }
  });

let runtimeFailed = false;
let runtimeError: unknown;
try {
  const server = startServer();
  const signals = ["SIGINT", "SIGTERM"] as const;
  const registeredSignals = new Set<(typeof signals)[number]>();
  const removeSignalListeners = () => {
    for (const signal of registeredSignals) {
      Deno.removeSignalListener(signal, shutdown);
    }
    registeredSignals.clear();
  };
  const shutdown = () => {
    removeSignalListeners();
    void server.shutdown();
  };
  try {
    for (const signal of signals) {
      Deno.addSignalListener(signal, shutdown);
      registeredSignals.add(signal);
    }
    await server.finished;
  } finally {
    removeSignalListeners();
  }
} catch (error) {
  runtimeFailed = true;
  runtimeError = error;
}

let closeFailed = false;
let closeError: unknown;
try {
  await resources.close();
} catch (error) {
  closeFailed = true;
  closeError = error;
}
if (runtimeFailed) {
  if (closeFailed) {
    throw new AggregateError(
      [runtimeError, closeError],
      "The GraphQL server failed and its resources could not be closed.",
    );
  }
  throw runtimeError;
}
if (closeFailed) throw closeError;
