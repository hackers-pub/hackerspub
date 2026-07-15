/// <reference lib="deno.unstable" />
import {
  App,
  fsRoutes,
  HttpError,
  staticFiles,
  trailingSlashes,
} from "@fresh/core";
import { type Context, createYogaServer } from "@hackerspub/graphql";
import { toApplicationContext } from "@hackerspub/federation/context";
import { handleMediumUploadProxy } from "@hackerspub/graphql/medium-upload";
import {
  ActorSuspendedError,
  isActorBanned,
} from "@hackerspub/models/moderation";
import { migrateLegacyOutboxEvents } from "@hackerspub/models/outbox";
import { deleteSession, getSession } from "@hackerspub/models/session";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { getXForwardedRequest } from "@hongminhee/x-forwarded-fetch";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_HEADER,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_HEADER,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_FULL,
} from "@opentelemetry/semantic-conventions";
import "@std/dotenv/load";
import { getCookies } from "@std/http/cookie";
import { serveDir } from "@std/http/file-server";
import { fromFileUrl } from "@std/path/from-file-url";
import {
  getDenoEnvironment,
  loadServerConfig,
} from "@hackerspub/runtime/config";
import {
  createRuntimeResources,
  runWithFederationQueue,
} from "@hackerspub/runtime/resources";
import { configureAiModels } from "./ai.ts";
import { configureDatabase } from "./db.ts";
import { configureDrive } from "./drive.ts";
import { configureEmail } from "./email.ts";
import { configureFederation } from "./federation.ts";
import { makeQueryGraphQL } from "./graphql/gql.ts";
import { configureKeyValue } from "./kv.ts";
import "./logging.ts";
import { runFreshServerUntilAborted } from "./server-lifecycle.ts";
import { services } from "./services.ts";
import type { State } from "./utils.ts";
import assetlinks from "../graphql/static/.well-known/assetlinks.json" with {
  type: "json",
};
import metadata from "./deno.json" with { type: "json" };
const appleAppSiteAssociationJson = Deno.readTextFileSync(
  new URL(
    "../graphql/static/.well-known/apple-app-site-association",
    import.meta.url,
  ),
);

const resources = await createRuntimeResources(
  loadServerConfig(getDenoEnvironment()),
  metadata.version,
  {
    fileSystemBaseUrl: new URL("./", import.meta.url),
    federation: {
      manuallyStartQueue: true,
      // TODO: Revert to Fedify's default RFC 9421-first behavior once
      // https://github.com/bonfire-networks/activity_pub/issues/8 is fixed
      // and released.
      firstKnock: "draft-cavage-http-signatures-12",
    },
  },
);
const { db, drive, email, federation, kv, models } = resources;
configureDatabase(resources);
configureDrive(drive);
configureEmail(email, resources.config.email.from);
configureFederation(federation, resources.config.origin);
configureKeyValue(kv);
configureAiModels(models);

export const app = new App<State>();
const staticHandler = staticFiles();
const yogaServer = createYogaServer();
app.use(async (ctx) => {
  // Work around a bug of Fresh's staticFiles middleware:
  if (ctx.url.pathname === "/.well-known/assetlinks.json") {
    return new Response(
      JSON.stringify(assetlinks),
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } else if (ctx.url.pathname === "/.well-known/apple-app-site-association") {
    return new Response(
      appleAppSiteAssociationJson,
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } else if (ctx.url.pathname.startsWith("/.well-known/")) {
    return await ctx.next();
  }
  return await staticHandler(ctx);
});

if (resources.config.storage.driver === "fs") {
  const fileSystemRoot = drive.fileSystemRoot;
  if (fileSystemRoot == null) {
    throw new TypeError("The filesystem drive has no resolved root path.");
  }
  app.use((ctx) => {
    if (!ctx.url.pathname.startsWith("/media/")) return ctx.next();
    return serveDir(ctx.req, {
      urlRoot: "media",
      fsRoot: fromFileUrl(fileSystemRoot),
    });
  });
}

if (resources.config.behindProxy) {
  app.use(async (ctx) => {
    // @ts-ignore: Fresh will fix https://github.com/denoland/fresh/pull/2751
    ctx.req = await getXForwardedRequest(ctx.req);
    // @ts-ignore: Fresh will fix https://github.com/denoland/fresh/pull/2751
    ctx.url = new URL(ctx.req.url);
    return await ctx.next();
  });
}

app.use(async (ctx) => {
  const tracer = trace.getTracer("fresh");
  return await tracer.startActiveSpan(ctx.req.method, {
    kind: SpanKind.SERVER,
    attributes: {
      [ATTR_HTTP_REQUEST_METHOD]: ctx.req.method,
      [ATTR_URL_FULL]: ctx.req.url,
    },
  }, async (span) => {
    if (span.isRecording()) {
      for (const [k, v] of ctx.req.headers) {
        span.setAttribute(ATTR_HTTP_REQUEST_HEADER(k), [v]);
      }
    }
    try {
      const response = await ctx.next();
      if (span.isRecording()) {
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);
        for (const [k, v] of response.headers) {
          span.setAttribute(ATTR_HTTP_RESPONSE_HEADER(k), [v]);
        }
        span.setStatus({
          code: response.status >= 500
            ? SpanStatusCode.ERROR
            : SpanStatusCode.UNSET,
          message: response.statusText,
        });
      }
      return response;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `${error}`,
      });
      throw error;
    } finally {
      span.end();
    }
  });
});

app.use(async (ctx) => {
  try {
    return await ctx.next();
  } catch (error) {
    // A suspended account hitting a guarded write path is an expected
    // moderation rejection, not a server error.
    if (error instanceof ActorSuspendedError) {
      return new Response("The account is suspended.", {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      });
    }
    throw error;
  }
});

app.use((ctx) => {
  let sessionId: Uuid | undefined = undefined;
  const authorization = ctx.req.headers.get("Authorization");
  if (authorization && authorization.startsWith("Bearer ")) {
    const uuid = authorization.slice(7).trim();
    if (validateUuid(uuid)) sessionId = uuid;
  }
  if (sessionId == null) {
    const cookies = getCookies(ctx.req.headers);
    if (validateUuid(cookies.session)) sessionId = cookies.session;
  }
  if (sessionId != null) {
    const sessionPromise = getSession(kv, sessionId)
      .then(async (session) => {
        if (session == null) return { account: undefined, session: undefined };
        const account = await db.query.accountTable.findFirst({
          where: { id: session.accountId },
          with: { actor: true, avatarMedium: true, emails: true, links: true },
        });
        if (account != null && account.kind !== "personal") {
          // Organization accounts are controlled through personal member
          // accounts. Any stale direct session must be invalidated.
          await deleteSession(kv, session.id);
          return { account: undefined, session: undefined };
        }
        if (account != null && isActorBanned(account.actor)) {
          // A ban invalidates existing sessions, not just new logins
          // (mirrors the GraphQL server's context build).
          await deleteSession(kv, session.id);
          return { account: undefined, session: undefined };
        }
        return {
          account,
          session: account == null ? undefined : session,
        };
      });
    ctx.state.sessionPromise = sessionPromise;
  }
  return ctx.next();
});

app.use(async (ctx) => {
  const uploadResponse = await handleMediumUploadProxy(
    ctx.req,
    kv,
    drive.use(),
  );
  if (uploadResponse != null) return uploadResponse;
  if (
    ctx.url.pathname.startsWith("/.well-known/") &&
      ctx.url.pathname !== "/.well-known/assetlinks.json" &&
      ctx.url.pathname !== "/.well-known/apple-app-site-association" ||
    ctx.url.pathname.startsWith("/ap/") ||
    ctx.url.pathname.startsWith("/nodeinfo/")
  ) {
    const disk = drive.use();
    return await federation.fetch(ctx.req, {
      contextData: { db, kv, disk, models, services },
    });
  }

  const disk = drive.use();
  const graphqlContext: Context = {
    altTextGenerator: models.altTextGenerator,
    db,
    kv,
    disk,
    email,
    emailFrom: resources.config.email.from,
    fedCtx: toApplicationContext(
      federation.createContext(ctx.req, {
        db,
        kv,
        disk,
        models,
        services,
      }),
    ),
    session: await ctx.state.sessionPromise?.then(({ session }) => session),
    account: await ctx.state.sessionPromise?.then(({ account }) => account),
    request: ctx.req,
    connectionInfo: ctx.info,
  };

  if (
    ctx.url.pathname === "/graphql" || ctx.url.pathname.startsWith("/graphql/")
  ) {
    return yogaServer.fetch(ctx.req, graphqlContext);
  } else {
    ctx.state.queryGraphQL = makeQueryGraphQL(graphqlContext);
  }
  return ctx.next();
});

app.use(trailingSlashes("never"));

await fsRoutes(app, {
  dir: "./",
  loadIsland: (path) => import(`./islands/${path}`),
  loadRoute: (path) => import(`./routes/${path}`),
});

export async function runWebServer(
  runServer: (signal: AbortSignal) => Promise<void>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const disk = drive.use();
  try {
    await migrateLegacyOutboxEvents(db);
    await runWithFederationQueue(
      federation,
      { db, kv, disk, models, services },
      (signal) => runFreshServerUntilAborted(runServer, signal),
      options,
    );
  } finally {
    await resources.close();
  }
}

export function closeWebResources(): Promise<void> {
  return resources.close();
}

if (import.meta.main) {
  const controller = new AbortController();
  const signalListeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  const removeSignalListeners = () => {
    for (const [signalName, listener] of signalListeners) {
      Deno.removeSignalListener(signalName, listener);
    }
    signalListeners.clear();
  };
  try {
    for (const signalName of ["SIGINT", "SIGTERM"] as const) {
      const listener = () => {
        removeSignalListeners();
        controller.abort();
      };
      Deno.addSignalListener(signalName, listener);
      signalListeners.set(signalName, listener);
    }
    await runWebServer(
      (signal) => app.listen({ signal }),
      { signal: controller.signal },
    );
  } finally {
    removeSignalListeners();
  }
}
