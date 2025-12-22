import prefixPlugin from "./prefixPlugin.js";
import mainPlugin from "./resolvePlugin.js";
export default function deno() {
  const cache = new Map();
  return [prefixPlugin(cache), mainPlugin(cache)];
}
