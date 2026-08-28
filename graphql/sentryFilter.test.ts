import assert from "node:assert";
import test from "node:test";
import { isIncomingRequestAbort } from "./sentryFilter.ts";

function incomingRequestAbort(): Error {
  const error = new Error("aborted");
  error.stack = [
    "Error: aborted",
    "    at abortIncoming (node:_http_server:911:17)",
    "    at socketOnClose (node:_http_server:904:3)",
    "    at TCP.<anonymous> (node:net:355:12)",
  ].join("\n");
  return error;
}

test("drops Node incoming-request aborts caused by disconnected clients", () => {
  assert.equal(isIncomingRequestAbort(incomingRequestAbort()), true);
});

test("keeps application errors that happen to say aborted", () => {
  assert.equal(isIncomingRequestAbort(new Error("aborted")), false);
  assert.equal(
    isIncomingRequestAbort(
      Object.assign(new Error("aborted"), {
        stack:
          "Error: aborted\n    at abortJob (file:///app/graphql/job.ts:1:1)",
      }),
    ),
    false,
  );
});

test("keeps other Node HTTP server failures", () => {
  assert.equal(
    isIncomingRequestAbort(
      Object.assign(new Error("socket failure"), {
        stack:
          "Error: socket failure\n" +
          "    at abortIncoming (node:_http_server:911:17)",
      }),
    ),
    false,
  );
});
