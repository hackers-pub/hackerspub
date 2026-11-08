const budgetKey = Symbol("ssrGraphQLBudget");

interface SsrGraphQLBudget {
  readonly started: number;
  deadline?: number;
}

type RequestLocals = Record<PropertyKey, unknown>;

/** Record page entry without allocating timers or reading SSR configuration. */
export function startSsrGraphQLBudget(locals: object): void {
  const record = locals as RequestLocals;
  record[budgetKey] ??= {
    started: performance.now(),
  } satisfies SsrGraphQLBudget;
}

/** Sequential queries share one immutable deadline, even between idle gaps. */
export function getSsrGraphQLDeadline(
  locals: object,
  budgetMs: number,
): number {
  startSsrGraphQLBudget(locals);
  const budget = (locals as RequestLocals)[budgetKey] as SsrGraphQLBudget;
  return (budget.deadline ??= budget.started + budgetMs);
}
