import assert from "node:assert";
import test from "node:test";
import { isSafariMediaControlError } from "./safariMediaError.ts";

const desktop =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15";
const ipad =
  "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
function event() {
  return {
    exception: {
      values: [
        {
          type: "ReferenceError",
          value: "Can't find variable: EmptyRanges",
          mechanism: {
            type: "auto.browser.global_handlers.onerror",
            handled: false,
          },
          stacktrace: {
            frames: [{ filename: "undefined", lineno: 1705, colno: 541 }],
          },
        },
      ],
    },
  };
}

test("Safari media controls: recognizes the observed desktop and iPad failures", () => {
  for (const agent of [desktop, ipad]) {
    assert.equal(isSafariMediaControlError(event(), agent), true);
    const missingFilename = event();
    Reflect.deleteProperty(
      missingFilename.exception.values[0].stacktrace.frames[0],
      "filename",
    );
    assert.equal(isSafariMediaControlError(missingFilename, agent), true);
  }
});

test("Safari media controls: preserves other browsers and application frames", () => {
  for (const agent of [
    "",
    desktop.replace("Version/26.6.2", "Chrome/160.0.0.0"),
    `${desktop} FxiOS/160.0`,
    "Mozilla/5.0 Firefox/160.0",
  ]) {
    assert.equal(isSafariMediaControlError(event(), agent), false);
  }
  for (const filename of [
    "https://hackers.pub/_build/assets/entry-client.js",
    "webpack:///src/app.tsx",
    "<anonymous>",
    "",
  ]) {
    const applicationError = event();
    applicationError.exception.values[0].stacktrace.frames[0].filename =
      filename;
    assert.equal(isSafariMediaControlError(applicationError, desktop), false);
  }
});

test("Safari media controls: preserves different error types, mechanisms and stacks", () => {
  const cases = [
    (value: ReturnType<typeof event>) => {
      value.exception.values[0].type = "TypeError";
    },
    (value: ReturnType<typeof event>) => {
      value.exception.values[0].value = "Can't find variable: anotherName";
    },
    (value: ReturnType<typeof event>) => {
      value.exception.values[0].mechanism.type =
        "auto.browser.global_handlers.onunhandledrejection";
    },
    (value: ReturnType<typeof event>) => {
      value.exception.values[0].mechanism.handled = true;
    },
    (value: ReturnType<typeof event>) => {
      value.exception.values[0].stacktrace.frames[0].lineno = 1706;
    },
    (value: ReturnType<typeof event>) => {
      value.exception.values[0].stacktrace.frames[0].colno = 542;
    },
    (value: ReturnType<typeof event>) => {
      value.exception.values[0].stacktrace.frames.push({
        filename: "https://hackers.pub/app.js",
        lineno: 1,
        colno: 1,
      });
    },
    (value: ReturnType<typeof event>) => {
      value.exception.values.push(value.exception.values[0]);
    },
  ];
  for (const change of cases) {
    const other = event();
    change(other);
    assert.equal(isSafariMediaControlError(other, desktop), false);
  }
  assert.equal(isSafariMediaControlError({}, desktop), false);
  assert.equal(
    isSafariMediaControlError({ exception: { values: [] } }, desktop),
    false,
  );
});
