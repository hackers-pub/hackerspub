import { toApplicationContext } from "@hackerspub/federation/context";
import type { RuntimeResources } from "@hackerspub/runtime/resources";
import type { YogaServerInstance } from "graphql-yoga";
import type { ServerContext, UserContext } from "./builder.ts";
import { handleFileSystemMedia } from "./file-system-media.ts";
import { handleMediumUploadProxy } from "./medium-upload.ts";
import { services } from "./services.ts";
import {
  applyTrustedForwarding,
  type ConnectionAddress,
  type ConnectionInfo,
} from "./trusted-forwarding.ts";

export interface GraphqlApiHandlerOptions {
  readonly resources: RuntimeResources;
  readonly yogaServer: YogaServerInstance<ServerContext, UserContext>;
  readonly assetlinksJson: string;
  readonly appleAppSiteAssociationJson: string;
}

export type GraphqlApiHandler = (
  request: Request,
  connectionInfo: ConnectionInfo<ConnectionAddress>,
) => Promise<Response>;

export function isFederationRequestPath(pathname: string): boolean {
  return (
    pathname.startsWith("/.well-known/") ||
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
 * Build the runtime-neutral Fetch handler shared by the Deno rollback entry
 * point and the Node.js API server.
 */
export function createGraphqlApiHandler(
  options: GraphqlApiHandlerOptions,
): GraphqlApiHandler {
  const { appleAppSiteAssociationJson, assetlinksJson, resources, yogaServer } =
    options;
  const { db, drive, email, federation, kv, models } = resources;
  const fileSystemRoot = drive.fileSystemRoot;

  return async (request, connectionInfo) => {
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
        return await federation.fetch(request, { contextData });
      }
      return await yogaServer.fetch(request, {
        altTextGenerator: models.altTextGenerator,
        db,
        kv,
        disk,
        email,
        emailFrom: resources.config.email.from,
        fedCtx: toApplicationContext(
          federation.createContext(request, contextData),
        ),
        request,
        connectionInfo: forwarded.connectionInfo,
      });
    } catch (error) {
      // Client disconnected before the server finished: this is not a server
      // failure, and the non-standard 499 status preserves the Deno behavior.
      if (isAbortError(error)) return new Response(null, { status: 499 });
      throw error;
    }
  };
}
