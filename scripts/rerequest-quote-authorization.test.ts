import assert from "node:assert";
import test from "node:test";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { parseRerequestQuoteAuthorizationArgs } from "./rerequest-quote-authorization.ts";

test("rerequest quote authorization defaults to all legacy quote posts", () => {
  assert.deepEqual(parseRerequestQuoteAuthorizationArgs([]), {
    dryRun: false,
  });
  assert.deepEqual(parseRerequestQuoteAuthorizationArgs(["--dry-run"]), {
    dryRun: true,
  });
});

test("rerequest quote authorization accepts one post UUID", () => {
  const uuid = generateUuidV7();
  assert.deepEqual(parseRerequestQuoteAuthorizationArgs([uuid, "--dry-run"]), {
    dryRun: true,
    uuid,
  });
  assert.throws(
    () => parseRerequestQuoteAuthorizationArgs([uuid, generateUuidV7()]),
    /at most one post UUID/,
  );
  assert.throws(
    () => parseRerequestQuoteAuthorizationArgs(["not-a-uuid"]),
    /Invalid UUID/,
  );
});
