import type { AnonymousReadStore } from "@hackerspub/runtime/anonymous-read-admission";
import type { AnonymousReadConfig } from "@hackerspub/runtime/config";
import { runWithRequestWork } from "@hackerspub/models/request-work";
import { getOperationAST, GraphQLError, type ExecutionResult } from "graphql";
import { createGraphQLError, type Plugin } from "graphql-yoga";
import type { UserContext } from "./builder.ts";
import { isCheapGuestQuery, publicReadKey } from "./anonymous-read-policy.ts";

export function anonymousReadOverload(reason: string): GraphQLError {
  return createGraphQLError(
    "Anonymous read capacity is unavailable. Try again shortly.",
    {
      extensions: {
        code: "ANONYMOUS_READ_OVERLOADED",
        reason,
        http: {
          status: 503,
          headers: { "retry-after": "1", "cache-control": "no-store" },
        },
      },
    },
  );
}

export interface AnonymousReadStats {
  active: number;
  acquiring: number;
  followers: number;
  authentication: number;
  cheap: number;
  admitted: number;
  shared: number;
  completed: number;
  cancelled: number;
  rejected: number;
  rejectedByReason: Record<string, number>;
}

interface ReadGroup<T> {
  readonly controller: AbortController;
  readonly started: number;
  readonly key: string | undefined;
  readonly promise: Promise<T>;
  readonly subscribers: Set<
    (result: T | undefined, error: unknown, failed: boolean) => void
  >;
}

/** No distinct-work queue; only bounded followers can wait on admitted work. */
export class AnonymousReadController {
  readonly store: AnonymousReadStore;
  readonly config: AnonymousReadConfig;
  readonly #groups = new Map<string, ReadGroup<unknown>>();
  #idle: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  readonly #stats: AnonymousReadStats = {
    active: 0,
    acquiring: 0,
    followers: 0,
    authentication: 0,
    cheap: 0,
    admitted: 0,
    shared: 0,
    completed: 0,
    cancelled: 0,
    rejected: 0,
    rejectedByReason: {},
  };

  constructor(store: AnonymousReadStore, config: AnonymousReadConfig) {
    this.store = store;
    this.config = config;
  }

  get stats(): Readonly<AnonymousReadStats> {
    return {
      ...this.#stats,
      rejectedByReason: { ...this.#stats.rejectedByReason },
    };
  }

  /** Wait for confirmed release of every admitted/acquiring execution. */
  idle(): Promise<void> {
    return this.#idle?.promise ?? Promise.resolve();
  }

  #reject(reason: string): never {
    this.#stats.rejected++;
    this.#stats.rejectedByReason[reason] =
      (this.#stats.rejectedByReason[reason] ?? 0) + 1;
    throw anonymousReadOverload(reason);
  }

  async authenticate<T>(execute: () => Promise<T>): Promise<T> {
    if (this.#stats.authentication >= this.config.authLimit)
      this.#reject("authentication");
    this.#stats.authentication++;
    try {
      return await execute();
    } finally {
      this.#stats.authentication--;
    }
  }

  async cheap<T>(request: Request, execute: () => Promise<T>): Promise<T> {
    request.signal.throwIfAborted();
    if (this.#stats.cheap >= this.config.cheapLimit) this.#reject("cheap");
    this.#stats.cheap++;
    try {
      return await execute();
    } finally {
      this.#stats.cheap--;
    }
  }

  run<T>(
    request: Request,
    key: string | undefined,
    execute: (request: Request) => Promise<T>,
  ): Promise<T> {
    request.signal.throwIfAborted();
    const existing = key == null ? undefined : this.#groups.get(key);
    if (
      existing != null &&
      !existing.controller.signal.aborted &&
      performance.now() - existing.started <= this.config.joinWindowMs
    ) {
      if (this.#stats.followers >= this.config.followerLimit)
        this.#reject("followers");
      this.#stats.followers++;
      this.#stats.shared++;
      return this.#subscribe(existing as ReadGroup<T>, request.signal, true);
    }
    if (this.#stats.active >= this.config.localLimit) this.#reject("local");
    if (this.#stats.active === 0) this.#idle = Promise.withResolvers<void>();
    this.#stats.active++;
    const controller = new AbortController();
    const owner = crypto.randomUUID();
    // Start in the next microtask, after registration and the first subscriber.
    const promise = Promise.resolve().then(async () => {
      let acquired = false;
      try {
        controller.signal.throwIfAborted();
        this.#stats.acquiring++;
        try {
          acquired = await this.store.acquire(owner);
        } catch {
          this.#reject("store");
        } finally {
          this.#stats.acquiring--;
        }
        if (!acquired) this.#reject("global");
        controller.signal.throwIfAborted();
        this.#stats.admitted++;
        // There is no body to consume here: execution uses already-parsed args.
        const workRequest = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          signal: controller.signal,
        });
        return await execute(workRequest);
      } finally {
        // Cancellation detaches callers promptly, but this finally runs only
        // after real resolver/SQL/external work and after-commit tasks settle.
        if (acquired) {
          try {
            await this.store.release(owner);
          } catch {
            this.#stats.rejectedByReason.release =
              (this.#stats.rejectedByReason.release ?? 0) + 1;
          }
        }
        this.#stats.active--;
        this.#stats.completed++;
        if (this.#stats.active === 0) {
          this.#idle?.resolve();
          this.#idle = undefined;
        }
        if (key != null && this.#groups.get(key) === group)
          this.#groups.delete(key);
      }
    });
    const group: ReadGroup<T> = {
      controller,
      started: performance.now(),
      key,
      promise,
      subscribers: new Set(),
    };
    // A local permit is reserved before inserting any new key.
    if (key != null)
      this.#groups.set(key, group as unknown as ReadGroup<unknown>);
    // The last subscriber may disconnect while the actual work keeps running.
    void promise.then(
      (result) => {
        for (const subscriber of group.subscribers)
          subscriber(result, undefined, false);
      },
      (error: unknown) => {
        for (const subscriber of group.subscribers)
          subscriber(undefined, error, true);
      },
    );
    return this.#subscribe(group, request.signal, false);
  }

  #subscribe<T>(
    group: ReadGroup<T>,
    signal: AbortSignal,
    follower: boolean,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const detach = () => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", abort);
        group.subscribers.delete(deliver);
        if (follower) this.#stats.followers--;
        return true;
      };
      const abort = () => {
        if (!detach()) return;
        this.#stats.cancelled++;
        if (group.subscribers.size === 0) {
          if (group.key != null && this.#groups.get(group.key) === group)
            this.#groups.delete(group.key);
          group.controller.abort(signal.reason);
        }
        reject(signal.reason);
      };
      const deliver = (
        result: T | undefined,
        error: unknown,
        failed: boolean,
      ) => {
        if (!detach()) return;
        if (failed) reject(error);
        else resolve(result as T);
      };
      group.subscribers.add(deliver);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

function cloneResult(result: ExecutionResult): ExecutionResult {
  return {
    ...result,
    ...(result.data == null ? {} : { data: structuredClone(result.data) }),
    ...(result.extensions == null
      ? {}
      : { extensions: structuredClone(result.extensions) }),
    ...(result.errors == null
      ? {}
      : {
          errors: result.errors.map(
            (error) =>
              new GraphQLError(error.message, {
                nodes: error.nodes,
                source: error.source,
                positions: error.positions,
                path: error.path,
                originalError: error.originalError,
                extensions: structuredClone(error.extensions),
              }),
          ),
        }),
  };
}

export function useAnonymousReadAdmission(
  controller: AnonymousReadController,
): Plugin<UserContext> {
  return {
    onExecute({ args, executeFn, setExecuteFn }) {
      const operation = getOperationAST(args.document, args.operationName);
      const context = args.contextValue as UserContext;
      if (
        operation?.operation !== "query" ||
        (context.account != null && context.session != null)
      )
        return;
      if (isCheapGuestQuery(args.document, args.operationName, context)) {
        setExecuteFn((nextArgs) =>
          controller.cheap(
            context.request,
            async () => await executeFn(nextArgs),
          ),
        );
        return;
      }
      const key = publicReadKey(
        args.document,
        args.operationName,
        args.variableValues,
        context.request,
      );
      setExecuteFn(async (nextArgs) => {
        const result = await controller.run(context.request, key, (request) => {
          // Never carry request-scoped loaders or a previous query snapshot into
          // a group. This context belongs exclusively to the admitted execution.
          const guest: UserContext = {
            altTextGenerator: context.altTextGenerator,
            db: context.db,
            kv: context.kv,
            disk: context.disk,
            email: context.email,
            emailAuth: context.emailAuth,
            emailFrom: context.emailFrom,
            fedCtx: context.fedCtx,
            connectionInfo: context.connectionInfo,
            request,
            session: undefined,
            account: undefined,
          };
          return runWithRequestWork(
            request.signal,
            async () => await executeFn({ ...nextArgs, contextValue: guest }),
          );
        });
        return cloneResult(result);
      });
    },
  };
}
