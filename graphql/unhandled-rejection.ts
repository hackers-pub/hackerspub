import { isRemoteTransportError } from "./logFilter.ts";

export interface UnhandledRejectionLogger {
  warning(message: string, properties: { readonly error: unknown }): void;
}

export interface UnhandledRejectionReporter {
  captureException(
    error: unknown,
    hint: {
      readonly mechanism: {
        readonly type: string;
        readonly handled: boolean;
      };
    },
  ): unknown;
}

export function reportUnhandledRejection(
  reason: unknown,
  logger: UnhandledRejectionLogger,
  reporter: UnhandledRejectionReporter,
): "remote" | "captured" {
  if (isRemoteTransportError(reason)) {
    logger.warning(
      "Remote peer error escaped as unhandled rejection: {error}",
      { error: reason },
    );
    return "remote";
  }
  logger.warning(
    "Unhandled promise rejection suppressed to keep the server alive: {error}",
    { error: reason },
  );
  reporter.captureException(reason, {
    mechanism: { type: "onunhandledrejection", handled: false },
  });
  return "captured";
}
