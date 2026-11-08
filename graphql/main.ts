// Sentry is initialized by the `--import ./instrument.ts` preload before
// this module graph is evaluated. LogTape must then be configured before any
// application resources are created.
import "./logging.ts";

import { getLogger, dispose as disposeLogging } from "@logtape/logtape";
import {
  getProcessEnvironment,
  loadAnonymousReadConfig,
  loadGraphqlApiConfig,
  loadHttpConfig,
  loadProtocolHttpConfig,
  type HttpRole,
} from "@hackerspub/runtime/config";
import {
  anonymousReadLedgerKey,
  createMemoryAnonymousReadStore,
  createRedisAnonymousReadStore,
  type AnonymousReadStore,
} from "@hackerspub/runtime/anonymous-read-admission";
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
import type { createYogaServer } from "./server.ts";
import { ProtocolAdmission } from "./protocol-admission.ts";
import {
  createNodeHttpServer,
  type NodeHttpServer,
  waitForNodeHttpShutdown,
} from "./node-http.ts";
import metadata from "./package.json" with { type: "json" };
import { AnonymousReadController } from "./anonymous-reads.ts";

const logger = getLogger(["hackerspub", "graphql"]);
const SENTRY_CLOSE_TIMEOUT = 2_000;

function registerShutdownSignals(controller: AbortController): () => void {
  const signals = ["SIGINT", "SIGTERM"] as const;
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const listener = () => {
      if (controller.signal.aborted) return;
      logger.info("Received {signal}; shutting down the HTTP service.", {
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

/**
 * Start the selected HTTP role only after its admission resources validate.
 * Startup failures and shutdown both drain and close acquired resources.
 */
export async function main(forcedRole?: HttpRole): Promise<void> {
  const shutdownController = new AbortController();
  const removeSignalListeners = registerShutdownSignals(shutdownController);
  let resources: RuntimeResources | undefined;
  let httpServer: NodeHttpServer | undefined;
  let yogaServer: ReturnType<typeof createYogaServer> | undefined;
  let runtimeError: unknown;
  let admissionStore: AnonymousReadStore | undefined;
  let admissionController: AnonymousReadController | undefined;
  let admissionStatsTimer: ReturnType<typeof setInterval> | undefined;
  let protocolStatsTimer: ReturnType<typeof setInterval> | undefined;
  let protocolAdmission: ProtocolAdmission | undefined;
  const stopProtocol = () => protocolAdmission?.stop();
  shutdownController.signal.addEventListener("abort", stopProtocol, {
    once: true,
  });

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
    const environment = getProcessEnvironment();
    const httpConfig = loadHttpConfig(environment, forcedRole);
    const protocolConfig =
      httpConfig.role === "protocol"
        ? loadProtocolHttpConfig(environment)
        : undefined;
    const allowFileKv =
      httpConfig.role === "combined" &&
      process.argv.includes("--allow-file-kv");
    const baseConfig = loadGraphqlApiConfig(environment, { allowFileKv });
    const config = {
      ...baseConfig,
      database: {
        ...baseConfig.database,
        maxConnections:
          baseConfig.database.maxConnections ??
          (httpConfig.role === "protocol" ? 4 : 20),
        applicationName: `hackerspub-${httpConfig.role}`,
        ...(httpConfig.role !== "protocol" || protocolConfig == null
          ? {}
          : {
              protocolWork: {
                limit: protocolConfig.sqlLimit,
                timeoutMs: protocolConfig.sqlTimeoutMs,
              },
            }),
      },
    };
    resources = await createRuntimeResources(config, metadata.version, {
      fileSystemBaseUrl: FILE_SYSTEM_STORAGE_BASE_URL,
      federation: {
        manuallyStartQueue: true,
        ...(httpConfig.role !== "protocol" || protocolConfig == null
          ? {}
          : {
              protocolHttp: {
                loaderLimit: protocolConfig.loaderLimit,
                loaderTimeoutMs: protocolConfig.loaderTimeoutMs,
              },
            }),
        // Keep this aligned with the queue worker.
        firstKnock: "draft-cavage-http-signatures-12",
      },
    });
    if (protocolConfig != null) {
      const protocol = new ProtocolAdmission(protocolConfig);
      protocolAdmission = protocol;
      if (shutdownController.signal.aborted) protocol.stop();
      const reportProtocol = () =>
        logger.info("Protocol HTTP admission: {admission}", () => ({
          admission: {
            ...protocol.stats,
            limits: protocolConfig,
            sql: resources?.sqlWorkStats?.(),
            loaders: resources?.protocolLoaderStats?.(),
          },
        }));
      reportProtocol();
      protocolStatsTimer = setInterval(reportProtocol, 30_000);
      protocolStatsTimer.unref();
    }
    if (httpConfig.role !== "protocol") {
      const admissionConfig = loadAnonymousReadConfig(getProcessEnvironment());
      admissionStore =
        resources.config.kv.url.protocol === "file:"
          ? createMemoryAnonymousReadStore(admissionConfig.globalLimit)
          : await createRedisAnonymousReadStore(
              resources.config.kv.url,
              resources.config.origin,
              admissionConfig.globalLimit,
              admissionConfig.redisTimeoutMs,
            );
      if (admissionStore.failure != null) {
        const recovery =
          admissionStore.failure === "ledger_missing_or_mismatched"
            ? "Drain all API replicas before repairing ledger metadata. "
            : "Check Redis connectivity and ledger metadata. If acknowledged " +
              "ownership state is intact, retry only this failed replica. ";
        throw new Error(
          `Anonymous read admission startup failed: ${admissionStore.failure}. ` +
            `Ledger ${anonymousReadLedgerKey(resources.config.origin)} ` +
            `must have format 1 and limit ${admissionConfig.globalLimit}. ` +
            recovery +
            "For metadata repair or suspected Redis state loss, follow the " +
            "drained recovery procedure in DEPLOYMENT.md.",
        );
      }
      const admission = new AnonymousReadController(
        admissionStore,
        admissionConfig,
      );
      admissionController = admission;
      const reportAdmission = () => {
        logger.info("Anonymous read admission: {admission}", {
          admission: {
            ...admission.stats,
            limits: admissionConfig,
            storeFailure: admissionStore?.failure ?? null,
            queued: 0,
          },
        });
      };
      reportAdmission();
      admissionStatsTimer = setInterval(reportAdmission, 30_000);
      admissionStatsTimer.unref();
      const { createYogaServer } = await import("./mod.ts");
      yogaServer = createYogaServer(admission);
    }
    const handler = createGraphqlApiHandler({
      resources,
      yogaServer,
      role: httpConfig.role,
      protocolAdmission,
      ready: () =>
        !shutdownController.signal.aborted && admissionStore?.failure == null,
      assetlinksJson,
      appleAppSiteAssociationJson,
    });
    httpServer = createNodeHttpServer(handler, {
      drainTimeout:
        protocolConfig == null ? 10_000 : protocolConfig.deadlineMs + 1000,
    });
    const address = await httpServer.listen({
      hostname: httpConfig.hostname,
      port: httpConfig.port,
    });
    logger.info("The {role} HTTP service is listening on {hostname}:{port}.", {
      role: httpConfig.role,
      hostname: address.address,
      port: address.port,
    });
    await waitForNodeHttpShutdown(httpServer.server, shutdownController.signal);
  } catch (error) {
    runtimeError = error;
  } finally {
    removeSignalListeners();
    if (admissionStatsTimer != null) clearInterval(admissionStatsTimer);
    if (protocolStatsTimer != null) clearInterval(protocolStatsTimer);
    shutdownController.signal.removeEventListener("abort", stopProtocol);
  }

  let closeError: unknown;
  try {
    await closeSequentially([
      () => httpServer?.close(),
      () => {
        protocolAdmission?.abort();
      },
      () => protocolAdmission?.idle(),
      async () => {
        if (
          admissionController != null &&
          admissionController.stats.active > 0
        ) {
          logger.info(
            "Waiting for {active} anonymous reads to finish before closing admission.",
            { active: admissionController.stats.active },
          );
        }
        await admissionController?.idle();
      },
      () => yogaServer?.dispose(),
      () => admissionStore?.close(),
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
