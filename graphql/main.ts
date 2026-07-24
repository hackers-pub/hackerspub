// Must be the first import — see instrument.ts for the rationale.
import "./instrument.ts";
import "./logging.ts";

import {
  getDenoEnvironment,
  loadGraphqlApiConfig,
} from "@hackerspub/runtime/config";
import {
  createRuntimeResources,
  FILE_SYSTEM_STORAGE_BASE_URL,
} from "@hackerspub/runtime/resources";
import { createGraphqlApiHandler } from "./api.ts";
import { createYogaServer } from "./mod.ts";
import assetlinks from "./static/.well-known/assetlinks.json" with { type: "json" };
import metadata from "./deno.json" with { type: "json" };
const appleAppSiteAssociationJson = Deno.readTextFileSync(
  new URL("./static/.well-known/apple-app-site-association", import.meta.url),
);

const yogaServer = createYogaServer();
const allowFileKv = Deno.args.includes("--allow-file-kv");
const resources = await createRuntimeResources(
  loadGraphqlApiConfig(getDenoEnvironment(), { allowFileKv }),
  metadata.version,
  {
    fileSystemBaseUrl: FILE_SYSTEM_STORAGE_BASE_URL,
    federation: {
      manuallyStartQueue: true,
      // TODO: Revert to Fedify's default RFC 9421-first behavior once
      // https://github.com/bonfire-networks/activity_pub/issues/8 is fixed
      // and released. Keep this aligned with the queue worker.
      firstKnock: "draft-cavage-http-signatures-12",
    },
  },
);
const handler = createGraphqlApiHandler({
  resources,
  yogaServer,
  assetlinksJson: JSON.stringify(assetlinks),
  appleAppSiteAssociationJson,
});

// The federation inbox/outbox queue worker and the periodic news-score sweep
// run in a separate process (`worker.ts`), not here: keeping that background
// work off this event loop and DB pool is what stops it from starving
// user-facing GraphQL requests into Caddy 504s (WEB-NEXT-1W).
const startServer = () =>
  Deno.serve({ port: 8080 }, (request, connectionInfo) =>
    handler(request, connectionInfo),
  );

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
