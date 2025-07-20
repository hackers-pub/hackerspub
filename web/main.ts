/// <reference lib="deno.unstable" />
import {
  App,
  fsRoutes,
  HttpError,
  staticFiles,
  trailingSlashes,
} from "@fresh/core";
import { type Context, createYogaServer } from "@hackerspub/graphql";
import { getSession } from "@hackerspub/models/session";
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
import * as models from "./ai.ts";
import { db } from "./db.ts";
import { drive } from "./drive.ts";
import { transport as email } from "./email.ts";
import { federation } from "./federation.ts";
import { makeQueryGraphQL } from "./graphql/gql.ts";
import { kv } from "./kv.ts";
import "./logging.ts";
import type { State } from "./utils.ts";

export const app = new App<State>();
const staticHandler = staticFiles();
const yogaServer = createYogaServer();
app.use(async (ctx) => {
  // Work around a bug of Fresh's staticFiles middleware:
  if (ctx.url.pathname.startsWith("/.well-known/")) return await ctx.next();
  return await staticHandler(ctx);
});

if (Deno.env.get("DRIVE_DISK") === "fs") {
  const FS_LOCATION = Deno.env.get("FS_LOCATION");
  if (FS_LOCATION == null) {
    throw new Error("Missing FS_LOCATION environment variable.");
  }

  app.use((ctx) => {
    if (!ctx.url.pathname.startsWith("/media/")) return ctx.next();
    return serveDir(ctx.req, {
      urlRoot: "media",
      fsRoot: FS_LOCATION,
    });
  });
}

if (Deno.env.get("BEHIND_PROXY") === "true") {
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
          with: { actor: true, emails: true, links: true },
        });
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
  if (
    ctx.url.pathname.startsWith("/.well-known/") ||
    ctx.url.pathname.startsWith("/ap/") ||
    ctx.url.pathname.startsWith("/nodeinfo/")
  ) {
    const disk = drive.use();
    return await federation.fetch(ctx.req, {
      contextData: { db, kv, disk, models },
    });
  }

  const disk = drive.use();
  const graphqlContext: Context = {
    db,
    kv,
    disk,
    email,
    fedCtx: federation.createContext(ctx.req, { db, kv, disk, models }),
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

if (import.meta.main) {
  await app.listen();
}
