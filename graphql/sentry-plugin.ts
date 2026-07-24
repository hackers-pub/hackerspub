import {
  getDocumentString,
  handleStreamOrSingleExecutionResult,
  isOriginalGraphQLError,
} from "@envelop/core";
import * as Sentry from "@sentry/node";
import { getOperationAST, print, type GraphQLError } from "graphql";
import type { Plugin } from "graphql-yoga";

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
 * a runtime-neutral `@sentry/core` alias shared by the Deno and Node SDKs.
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
            sentry.withActiveSpan(rootSpan, () => executeFn(executeArgs)),
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
