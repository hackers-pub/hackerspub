import nodeProcess from "node:process";

function readMilliseconds(name: string, fallback: number): number {
  const value = nodeProcess.env[name];
  if (value === undefined) return fallback;
  const milliseconds = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 2_147_483_647
  ) {
    throw new Error(`${name} must be an integer from 1 to 2147483647`);
  }
  return milliseconds;
}

export function getSsrGraphQLPolicy(): { timeoutMs: number; budgetMs: number } {
  return {
    timeoutMs: readMilliseconds("WEB_SSR_GRAPHQL_TIMEOUT_MS", 10_000),
    budgetMs: readMilliseconds("WEB_SSR_GRAPHQL_BUDGET_MS", 15_000),
  };
}

export function getInteractiveGraphQLTimeout(): number {
  return readMilliseconds("WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS", 180_000);
}
