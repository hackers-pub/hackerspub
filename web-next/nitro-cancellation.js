/* global defineNitroPlugin, toWebRequest */
// Nitro auto-imports its own runtime and h3 helpers. Keep this adapter in
// that build environment, outside the browser/Solid module graph.
import { createNodeRequestLifetime } from "./src/lib/nodeRequestLifetime.ts";

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook("request", (event) => {
    if (event.node?.req == null || event.node?.res == null) return;
    const original = toWebRequest(event);
    const lifetime = createNodeRequestLifetime(
      event.node.req,
      event.node.res,
      original.signal,
    );
    try {
      // h3 v1's default toWebRequest omits the Node disconnect signal.
      // Its fromWebHandler uses this replacement without rebuilding it.
      event.web = {
        ...event.web,
        request: new Request(original, { signal: lifetime.signal }),
      };
    } catch (error) {
      lifetime.dispose();
      throw error;
    }
  });
});
