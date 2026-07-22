// Aliased to avoid clashing with the `import process from "node:process"`
// that Nitro injects at the top of every SSR bundle. With the default name,
// Rollup ends up emitting two `import process` statements in entry-server.mjs
// and Node fails to parse it (SyntaxError: Identifier 'process' has already
// been declared).
import nodeProcess from "node:process";

function getRequiredEnv(name: string): string {
  const value = nodeProcess.env[name];
  if (value === undefined) {
    throw new Error(`${name} environment variable is not set`);
  }
  return value;
}

export const CANONICAL_ORIGIN_URL = new URL(getRequiredEnv("ORIGIN"));

export function getApiUrl(): string {
  return getRequiredEnv("API_URL");
}

export function getBehindProxy(): boolean {
  return nodeProcess.env.BEHIND_PROXY?.toLowerCase() === "true";
}
