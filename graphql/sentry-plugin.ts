import {
  getDocumentString,
  handleStreamOrSingleExecutionResult,
  isOriginalGraphQLError,
} from "@envelop/core";
import { getLogger } from "@logtape/logtape";
import { PothosValidationError } from "@pothos/core";
import { ForbiddenError } from "@pothos/plugin-scope-auth";
import * as Sentry from "@sentry/node";
import { getOperationAST, GraphQLError, print } from "graphql";
import type { Plugin } from "graphql-yoga";

const logger = getLogger(["hackerspub", "graphql", "sentry-plugin"]);

interface SentrySpan {
  setAttribute(name: string, value: unknown): void;
  end(): void;
}

interface SentryScope {
  setTransactionName(name: string): void;
  setTag(name: string, value: string): void;
  setExtra(name: string, value: unknown): void;
  addBreadcrumb(breadcrumb: {
    readonly category: string;
    readonly message: string;
    readonly level: "debug";
  }): void;
}

export interface SentryPluginClient {
  startSpanManual<T>(
    options: {
      readonly name: string;
      readonly op: string;
      readonly attributes: Record<string, string>;
      readonly forceTransaction: false;
    },
    callback: (span: SentrySpan) => T,
  ): T;
  withActiveSpan<T>(span: SentrySpan, callback: () => T): T;
  withScope<T>(callback: (scope: SentryScope) => T): T;
  captureException(
    error: unknown,
    hint: {
      readonly fingerprint: string[];
      readonly contexts: {
        readonly GraphQL: {
          readonly operationName: string;
          readonly operationType: string;
        };
      };
    },
  ): string;
}

function addEventId(error: GraphQLError, eventId: string): GraphQLError {
  error.extensions.sentryEventId = eventId;
  return error;
}

/**
 * Creates the default `@envelop/sentry` behavior without importing its
 * hard-coded `@sentry/node` dependency.  In this repository that specifier is
 * an alias for `@sentry/core`, which carries no SDK-specific integrations.
 */
export function useSentry(
  sentry: SentryPluginClient = Sentry as SentryPluginClient,
): Plugin {
  return {
    onExecute({ args, executeFn, setExecuteFn }) {
      const rootOperation = getOperationAST(
        args.document,
        args.operationName ?? undefined,
      );
      if (rootOperation == null) return;

      const operationType = rootOperation.operation;
      const document = getDocumentString(args.document, print);
      const operationName =
        args.operationName ??
        rootOperation.name?.value ??
        "Anonymous Operation";
      const tags = {
        operationName,
        operation: operationType,
      };

      return sentry.startSpanManual(
        {
          name: operationName,
          op: "execute",
          attributes: tags,
          forceTransaction: false,
        },
        (rootSpan) => {
          rootSpan.setAttribute("document", document);
          setExecuteFn((executeArgs) =>
            sentry.withActiveSpan(rootSpan, async () => {
              try {
                return await executeFn(executeArgs);
              } catch (error) {
                // Envelop skips onExecuteDone when an execution wrapper
                // throws, including snapshot transaction failures.
                const originalError =
                  error instanceof GraphQLError
                    ? (error.originalError ?? error)
                    : error;
                try {
                  if (
                    !isOriginalGraphQLError(error) &&
                    !(originalError instanceof ForbiddenError) &&
                    !(originalError instanceof PothosValidationError)
                  ) {
                    sentry.withScope((scope) => {
                      scope.setTransactionName(operationName);
                      scope.setTag("operation", operationType);
                      scope.setTag("operationName", operationName);
                      scope.setExtra("document", document);
                      sentry.captureException(originalError, {
                        fingerprint: [
                          "graphql",
                          "$execute",
                          operationName,
                          operationType,
                        ],
                        contexts: {
                          GraphQL: { operationName, operationType },
                        },
                      });
                    });
                  }
                } catch (reportingError) {
                  logger.warn(
                    "Failed to report GraphQL execution failure: {reportingError}",
                    { reportingError, operationName, operationType },
                  );
                } finally {
                  rootSpan.end();
                }
                throw error;
              }
            }),
          );
          return {
            onExecuteDone(payload) {
              return handleStreamOrSingleExecutionResult(
                payload,
                ({ result, setResult }) => {
                  if (result.errors != null && result.errors.length > 0) {
                    sentry.withScope((scope) => {
                      scope.setTransactionName(operationName);
                      scope.setTag("operation", operationType);
                      scope.setTag("operationName", operationName);
                      scope.setExtra("document", document);
                      const errors = result.errors?.map((error) => {
                        if (isOriginalGraphQLError(error)) return error;
                        if (
                          error.originalError instanceof ForbiddenError ||
                          error.originalError instanceof PothosValidationError
                        ) {
                          return error;
                        }
                        const errorPath = (error.path ?? [])
                          .map((part: string | number) =>
                            typeof part === "number" ? "$index" : part,
                          )
                          .join(" > ");
                        if (errorPath !== "") {
                          scope.addBreadcrumb({
                            category: "execution-path",
                            message: errorPath,
                            level: "debug",
                          });
                        }
                        const eventId = sentry.captureException(
                          error.originalError,
                          {
                            fingerprint: [
                              "graphql",
                              errorPath,
                              operationName,
                              operationType,
                            ],
                            contexts: {
                              GraphQL: {
                                operationName,
                                operationType,
                              },
                            },
                          },
                        );
                        return addEventId(error, eventId);
                      });
                      setResult({ ...result, errors });
                    });
                  }
                  rootSpan.end();
                },
              );
            },
          };
        },
      );
    },
  };
}
