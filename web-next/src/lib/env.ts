import process from "node:process";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} environment variable is not set`);
  }
  return value;
}

export const CANONICAL_ORIGIN_URL = new URL(getRequiredEnv("ORIGIN"));
