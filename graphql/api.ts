import { toApplicationContext } from "@hackerspub/federation/context";
import { handleNotAcceptable } from "@hackerspub/federation/html-redirect";
import type { RuntimeResources } from "@hackerspub/runtime/resources";
import type { HttpRole } from "@hackerspub/runtime/config";
import type { YogaServerInstance } from "graphql-yoga";
import type { ServerContext, UserContext } from "./builder.ts";
import { handleFileSystemMedia } from "./file-system-media.ts";
import { handleMediumUploadProxy } from "./medium-upload.ts";
import { services } from "./services.ts";
import type { ProtocolAdmission } from "./protocol-admission.ts";
import {
  applyTrustedForwarding,
  type ConnectionAddress,
  type ConnectionInfo,
} from "./trusted-forwarding.ts";

export interface GraphqlApiHandlerOptions {
  readonly resources: RuntimeResources;
  readonly yogaServer?: YogaServerInstance<ServerContext, UserContext>;
  readonly assetlinksJson: string;
  readonly appleAppSiteAssociationJson: string;
  readonly role?: HttpRole;
  readonly protocolAdmission?: ProtocolAdmission;
  readonly ready?: () => boolean;
}

export type GraphqlApiHandler = (
  request: Request,
  connectionInfo: ConnectionInfo<ConnectionAddress>,
) => Promise<Response>;

export function isFederationRequestPath(pathname: string): boolean {
  return (
    (pathname.startsWith("/.well-known/") &&
      pathname !== "/.well-known/assetlinks.json" &&
      pathname !== "/.well-known/apple-app-site-association") ||
    pathname.startsWith("/ap/") ||
    pathname.startsWith("/nodeinfo/")
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Build the Fetch handler that the Node.js API server adapts to
 * `node:http`.  Keeping it runtime-neutral also keeps it directly testable
 * without standing a server up.
 */
export function createGraphqlApiHandler(
  options: GraphqlApiHandlerOptions,
): GraphqlApiHandler {
  const { appleAppSiteAssociationJson, assetlinksJson, resources, yogaServer } =
    options;
  const { db, drive, email, emailAuth, federation, kv, models } = resources;
  const fileSystemRoot = drive.fileSystemRoot;
  const role = options.role ?? "combined";
  const admission = options.protocolAdmission;
  if (role !== "protocol" && yogaServer == null) {
    throw new TypeError("Interactive HTTP requires a GraphQL server.");
  }
  if (role === "protocol" && admission == null) {
    throw new TypeError("Protocol HTTP requires bounded admission.");
  }

  const dispatch: GraphqlApiHandler = async (request, connectionInfo) => {
    try {
      const forwarded = await applyTrustedForwarding(
        request,
        connectionInfo,
        resources.config.behindProxy,
      );
      request = forwarded.request;
      const url = new URL(request.url);
      const disk = drive.use();
      const uploadResponse = await handleMediumUploadProxy(request, kv, disk);
      if (uploadResponse != null) return uploadResponse;
      const mediaResponse = await handleFileSystemMedia(
        request,
        fileSystemRoot,
      );
      if (mediaResponse != null) return mediaResponse;
      if (url.pathname === "/.well-known/assetlinks.json") {
        return new Response(assetlinksJson, {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/.well-known/apple-app-site-association") {
        return new Response(appleAppSiteAssociationJson, {
          headers: { "content-type": "application/json" },
        });
      }
      const contextData = { db, kv, disk, models, services };
      if (isFederationRequestPath(url.pathname)) {
        return await federation.fetch(request, {
          contextData,
          onNotAcceptable: (request) =>
            handleNotAcceptable(
              federation.createContext(request, contextData),
              request,
            ),
        });
      }
      return await yogaServer!.fetch(request, {
        altTextGenerator: models.altTextGenerator,
        db,
        kv,
        disk,
        email,
        emailAuth,
        emailFrom: resources.config.email.from,
        fedCtx: toApplicationContext(
          federation.createContext(request, contextData),
        ),
        request,
        connectionInfo: forwarded.connectionInfo,
      });
    } catch (error) {
      // Client disconnected before the server finished: this is not a server
      // failure, and the non-standard 499 status records it as such.
      if (isAbortError(error)) return new Response(null, { status: 499 });
      throw error;
    }
  };
  return async (request, connectionInfo) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD", connection: "close" },
        });
      }
      const ready = (options.ready?.() ?? true) && !admission?.stats.stopping;
      return new Response(
        request.method === "HEAD" ? null : JSON.stringify({ ready, role }),
        {
          status: ready ? 200 : 503,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            // Raw HTTP GET/HEAD can carry an unfinished body too. Close the
            // transport after the reply without buffering health-check bodies.
            connection: "close",
          },
        },
      );
    }
    const protocol = isFederationRequestPath(pathname);
    // Forwarding can buffer a body. Reject ownership/capacity first.
    if (
      (role === "interactive" && protocol) ||
      (role === "protocol" && !protocol)
    ) {
      return new Response("Not Found", {
        status: 404,
        headers: { connection: "close" },
      });
    }
    if (protocol && admission != null) {
      return await admission.run(request, (admitted) =>
        dispatch(admitted, connectionInfo),
      );
    }
    return await dispatch(request, connectionInfo);
  };
}
