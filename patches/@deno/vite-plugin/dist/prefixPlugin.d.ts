import type { Plugin } from "vite";
import { type DenoResolveResult } from "./resolver.js";
export default function denoPrefixPlugin(
  cache: Map<string, DenoResolveResult>,
): Plugin;
