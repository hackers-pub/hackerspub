import "@std/dotenv/load";
import "./logging.ts";
import { App, fsRoutes, staticFiles } from "fresh";
import { type State } from "./utils.ts";

export const app = new App<State>();
app.use(staticFiles());

await fsRoutes(app, {
  dir: "./",
  loadIsland: (path) => import(`./islands/${path}`),
  loadRoute: (path) => import(`./routes/${path}`),
});

if (import.meta.main) {
  await app.listen();
}
