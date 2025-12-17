import type { Plugin } from "vite";
import { type DenoResolveResult } from "./resolver.js";
export default function denoPlugin(
  cache: Map<string, DenoResolveResult>,
): Plugin;
