/// <reference lib="deno.unstable" />
import "@std/dotenv/load";
import "./logging.ts";
import "./sentry.ts";
import { getXForwardedRequest } from "@hongminhee/x-forwarded-fetch";
import { captureException } from "@sentry/deno";
import { App, fsRoutes, staticFiles, trailingSlashes } from "fresh";
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
    return await ctx.next();
  });
}

app.use(async (ctx) => {
  if (
    ctx.url.pathname.startsWith("/.well-known/") ||
    ctx.url.pathname.startsWith("/ap/") ||
    ctx.url.pathname.startsWith("/nodeinfo/")
  ) {
    try {
      return await federation.fetch(ctx.req, {
        contextData: undefined,
      });
    } catch (error) {
      captureException(error);
      throw error;
    }
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
