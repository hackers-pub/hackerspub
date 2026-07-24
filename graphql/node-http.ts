import { getLogger } from "@logtape/logtape";
import * as Sentry from "@sentry/node-sdk";
import type { Server } from "node:http";
import { type AddressInfo, isIP } from "node:net";
// srvx's shared declarations import globals for every supported runtime,
// including Cloudflare Workers. Keep those globals out of Deno's type graph.
// @ts-types="./srvx-node.d.ts"
import { serve } from "srvx/node";
import type { GraphqlApiHandler } from "./api.ts";
import type {
  ConnectionAddress,
  ConnectionInfo,
} from "./trusted-forwarding.ts";

export interface NodeHttpLogger {
  warning(message: string, properties: { readonly error: unknown }): void;
}

export interface NodeHttpServerOptions {
  readonly captureException?: (error: unknown) => unknown;
  readonly drainTimeout?: number;
  readonly logger?: NodeHttpLogger;
}

export interface NodeHttpListenOptions {
  readonly hostname?: string;
  readonly port?: number;
}

export interface NodeHttpServer {
  readonly server: Server;
  listen(options?: NodeHttpListenOptions): Promise<AddressInfo>;
  close(): Promise<void>;
}

interface NodeConnectionRequest {
  readonly socket?: {
    readonly remoteAddress?: string;
    readonly remotePort?: number;
  };
}

function normalizeRemoteAddress(
  address: string | undefined,
): string | undefined {
  if (address?.startsWith("::ffff:")) {
    const ipv4 = address.slice("::ffff:".length);
    if (isIP(ipv4) === 4) return ipv4;
  }
  return address;
}

export function getNodeConnectionInfo(
  request: NodeConnectionRequest,
): ConnectionInfo<ConnectionAddress> {
  const hostname = normalizeRemoteAddress(request.socket?.remoteAddress);
  const port = request.socket?.remotePort;
  return {
    remoteAddr: {
      transport: hostname == null ? "unix" : "tcp",
      ...(hostname == null ? {} : { hostname }),
      ...(port == null ? {} : { port }),
    },
  };
}

export function createNodeHttpServer(
  handler: GraphqlApiHandler,
  options: NodeHttpServerOptions = {},
): NodeHttpServer {
  const captureException = options.captureException ?? Sentry.captureException;
  const drainTimeout = options.drainTimeout ?? 10_000;
  if (
    !Number.isInteger(drainTimeout) ||
    drainTimeout < 0 ||
    drainTimeout > 2_147_483_647
  ) {
    throw new RangeError(
      "The Node HTTP drain timeout must be an integer from 0 to 2147483647.",
    );
  }
  const logger = options.logger ?? getLogger(["hackerspub", "graphql", "http"]);
  let srvxServer: ReturnType<typeof serve> | undefined;

  const getServer = (): Server => {
    const server = srvxServer?.node?.server;
    if (server == null) {
      throw new TypeError("The srvx Node.js server has not been initialized.");
    }
    // This adapter never enables srvx's TLS or HTTP/2 options, so the runtime
    // server is always a node:http Server.
    return server as Server;
  };

  return {
    get server() {
      return getServer();
    },
    async listen(listenOptions = {}) {
      if (srvxServer != null) {
        throw new TypeError("The GraphQL HTTP server is already initialized.");
      }
      const hostname = listenOptions.hostname ?? "0.0.0.0";
      const port = listenOptions.port ?? 8080;
      srvxServer = serve({
        hostname,
        port,
        silent: true,
        // The composition root owns signal handling so it can drain HTTP
        // before closing Yoga, runtime resources, LogTape, and Sentry.
        gracefulShutdown: false,
        fetch(request) {
          const nodeRequest = request.runtime?.node?.req;
          if (nodeRequest == null) {
            throw new TypeError("srvx did not expose its Node.js request.");
          }
          return handler(request, getNodeConnectionInfo(nodeRequest));
        },
        error(error) {
          // Capture directly so this remains one exception event. The warning
          // stays below the LogTape Sentry sink's error threshold.
          logger.warning("GraphQL HTTP request failed: {error}", { error });
          captureException(error);
          return new Response("Internal Server Error", {
            status: 500,
            headers: { "content-type": "text/plain; charset=UTF-8" },
          });
        },
      });
      await srvxServer.ready();
      const address = getServer().address();
      if (address == null || typeof address === "string") {
        throw new TypeError("The GraphQL HTTP server did not bind a TCP port.");
      }
      return address;
    },
    async close() {
      if (srvxServer == null) return;
      const gracefulClose = srvxServer.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          gracefulClose,
          new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => {
              try {
                const error = new Error(
                  `GraphQL HTTP drain exceeded ${drainTimeout} ms.`,
                );
                logger.warning(
                  "Forcing active GraphQL HTTP connections closed: {error}",
                  { error },
                );
                getServer().closeAllConnections();
                resolve();
              } catch (error) {
                reject(error);
              }
            }, drainTimeout);
          }),
        ]);
      } finally {
        if (timer != null) clearTimeout(timer);
      }
    },
  };
}

export async function waitForNodeHttpShutdown(
  server: Server,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
      server.off("error", handleError);
    };
    const handleAbort = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    server.once("error", handleError);
    if (signal.aborted) handleAbort();
  });
}
