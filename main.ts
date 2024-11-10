import "@std/dotenv/load";
import "./logging.ts";
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

app.use(async (ctx) => {
  if (
    ctx.url.pathname.startsWith("/.well-known/") ||
    ctx.url.pathname.startsWith("/ap/") ||
    ctx.url.pathname.startsWith("/nodeinfo/")
  ) {
    return await federation.fetch(ctx.req, {
      contextData: undefined,
    });
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
