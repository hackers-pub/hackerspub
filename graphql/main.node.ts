// Sentry is initialized by the `--import ./instrument.node.ts` preload before
// this module graph is evaluated. LogTape must then be configured before any
// application resources are created.
import "./logging.node.ts";

import { getLogger, dispose as disposeLogging } from "@logtape/logtape";
import {
  getProcessEnvironment,
  loadGraphqlApiConfig,
} from "@hackerspub/runtime/config";
import { isMain } from "@hackerspub/runtime/main";
import {
  createRuntimeResources,
  FILE_SYSTEM_STORAGE_BASE_URL,
  type RuntimeResources,
} from "@hackerspub/runtime/resources";
import * as Sentry from "@sentry/node-sdk";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { createGraphqlApiHandler } from "./api.ts";
import {
  combineRuntimeAndCloseErrors,
  closeSequentially,
} from "./lifecycle.ts";
import { createYogaServer } from "./mod.ts";
import {
  createNodeHttpServer,
  type NodeHttpServer,
  waitForNodeHttpShutdown,
} from "./node-http.ts";
import metadata from "./deno.json" with { type: "json" };

const logger = getLogger(["hackerspub", "graphql"]);
const SENTRY_CLOSE_TIMEOUT = 2_000;

function registerShutdownSignals(controller: AbortController): () => void {
  const signals = ["SIGINT", "SIGTERM"] as const;
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const listener = () => {
      if (controller.signal.aborted) return;
      logger.info("Received {signal}; shutting down the GraphQL API.", {
        signal,
      });
      controller.abort();
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  return () => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
  };
}

export async function main(): Promise<void> {
  const shutdownController = new AbortController();
  const removeSignalListeners = registerShutdownSignals(shutdownController);
  let resources: RuntimeResources | undefined;
  let httpServer: NodeHttpServer | undefined;
  let yogaServer: ReturnType<typeof createYogaServer> | undefined;
  let runtimeError: unknown;

  try {
    const [assetlinksJson, appleAppSiteAssociationJson] = await Promise.all([
      readFile(
        new URL("./static/.well-known/assetlinks.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "./static/.well-known/apple-app-site-association",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    const allowFileKv = process.argv.includes("--allow-file-kv");
    resources = await createRuntimeResources(
      loadGraphqlApiConfig(getProcessEnvironment(), { allowFileKv }),
      metadata.version,
      {
        fileSystemBaseUrl: FILE_SYSTEM_STORAGE_BASE_URL,
        federation: {
          manuallyStartQueue: true,
          // Keep this aligned with the Deno rollback API and queue worker.
          firstKnock: "draft-cavage-http-signatures-12",
        },
      },
    );
    yogaServer = createYogaServer();
    const handler = createGraphqlApiHandler({
      resources,
      yogaServer,
      assetlinksJson,
      appleAppSiteAssociationJson,
    });
    httpServer = createNodeHttpServer(handler);
    const address = await httpServer.listen();
    logger.info("The Node.js GraphQL API is listening on {hostname}:{port}.", {
      hostname: address.address,
      port: address.port,
    });
    await waitForNodeHttpShutdown(httpServer.server, shutdownController.signal);
  } catch (error) {
    runtimeError = error;
  } finally {
    removeSignalListeners();
  }

  let closeError: unknown;
  try {
    await closeSequentially([
      () => httpServer?.close(),
      () => yogaServer?.dispose(),
      () => resources?.close(),
      () => disposeLogging(),
    ]);
  } catch (error) {
    closeError = error;
  }

  const finalError = combineRuntimeAndCloseErrors(runtimeError, closeError);
  if (finalError != null) Sentry.captureException(finalError);
  try {
    await Sentry.close(SENTRY_CLOSE_TIMEOUT);
  } catch (error) {
    if (finalError != null) {
      throw new AggregateError(
        [finalError, error],
        "The GraphQL API failed and Sentry could not be closed.",
      );
    }
    throw error;
  }
  if (finalError != null) throw finalError;
}

if (isMain(import.meta)) await main();
