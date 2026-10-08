interface BrowserErrorEvent {
  exception?: {
    values?: {
      type?: string;
      value?: string;
      mechanism?: { type?: string; handled?: boolean };
      stacktrace?: {
        frames?: { filename?: string; lineno?: number; colno?: number }[];
      };
    }[];
  };
}

// WebKit's built-in media controls reference an out-of-scope EmptyRanges
// after their media weak reference is collected. Match the observed native
// stack only; application ReferenceErrors must remain visible.
// https://github.com/WebKit/WebKit/commit/b13f9879ad3ca87db952d919932d0f31e52b38ea
export function isSafariMediaControlError(
  event: BrowserErrorEvent,
  userAgent: string,
): boolean {
  if (
    !/AppleWebKit\//.test(userAgent) ||
    !/Version\/[\d.]+.*Safari\//.test(userAgent) ||
    /Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/.test(userAgent)
  ) {
    return false;
  }
  const values = event.exception?.values;
  if (values?.length !== 1) return false;
  const error = values[0];
  if (
    error.type !== "ReferenceError" ||
    error.value !== "Can't find variable: EmptyRanges" ||
    error.mechanism?.type !== "auto.browser.global_handlers.onerror" ||
    error.mechanism.handled !== false
  ) {
    return false;
  }
  const frames = error.stacktrace?.frames;
  if (frames?.length !== 1) return false;
  const frame = frames[0];
  return (
    (frame.filename == null || frame.filename === "undefined") &&
    frame.lineno === 1705 &&
    frame.colno === 541
  );
}
