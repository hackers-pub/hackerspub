/// <reference lib="deno.unstable" />
import "@std/dotenv/load";
import "./logging.ts";
import "./sentry.ts";
import { getXForwardedRequest } from "@hongminhee/x-forwarded-fetch";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_HEADER,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_HEADER,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_FULL,
} from "@opentelemetry/semantic-conventions";
import { captureException } from "@sentry/deno";
import { App, fsRoutes, HttpError, staticFiles, trailingSlashes } from "fresh";
import { federation } from "./federation/mod.ts";
import { type State } from "./utils.ts";

export const app = new App<State>();
const staticHandler = staticFiles();
app.use(async (ctx) => {
  // Work around a bug of Fresh's staticFiles middleware:
  if (ctx.url.pathname.startsWith("/.well-known/")) return ctx.next();
  return await staticHandler(ctx);
});

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
      captureException(error);
      throw error;
    } finally {
      span.end();
    }
  });
});

app.use(async (ctx) => {
  if (
    ctx.url.pathname.startsWith("/.well-known/") ||
    ctx.url.pathname.startsWith("/ap/") ||
    ctx.url.pathname.startsWith("/nodeinfo/")
  ) {
    return await federation.fetch(ctx.req, { contextData: undefined });
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
