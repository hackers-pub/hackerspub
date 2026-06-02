import assert from "node:assert/strict";
import test from "node:test";
import type { LogRecord } from "@logtape/logtape";
import {
  isRemoteTransportError,
  isRoutineFederationError,
} from "./logFilter.ts";

function record(
  category: string[],
  rawMessage: string,
  properties: Record<string, unknown> = {},
): LogRecord {
  return {
    category,
    level: "error",
    message: [rawMessage],
    rawMessage,
    timestamp: 0,
    properties,
  };
}

// A Deno `fetch` transport failure (DNS/TLS/connection): a `TypeError` whose
// message begins with "error sending request for url (...)".
function denoFetchError(detail: string): TypeError {
  return new TypeError(
    `error sending request for url (https://social.nove-b.dev/inbox): ${detail}`,
  );
}

// Fedify's document loader throws this (a non-`Error` subclass is fine; the
// predicate keys off the `name`) when a dereferenced document responds non-OK.
function fetchError(): Error {
  const error = new Error("HTTP 404: https://mk.yopo.work/notes/amyvdf8x3a");
  error.name = "FetchError";
  return error;
}

test("docloader: drops a remote HTTP error status (>= 400)", () => {
  const r = record(
    ["fedify", "runtime", "docloader"],
    "Failed to fetch document: {status} {url} {headers}",
    { status: 404 },
  );
  assert.equal(isRoutineFederationError(r), true);
});

test("docloader: keeps status-less errors (e.g. disallowed private URL)", () => {
  const r = record(
    ["fedify", "runtime", "docloader"],
    "Disallowed private URL: {url}",
    { url: "http://169.254.169.254/" },
  );
  assert.equal(isRoutineFederationError(r), false);
});

test("docloader: keeps a non-error status (< 400)", () => {
  const r = record(
    ["fedify", "runtime", "docloader"],
    "Failed to fetch document: {status} {url} {headers}",
    { status: 301 },
  );
  assert.equal(isRoutineFederationError(r), false);
});

test("outbox: drops a delivery failure", () => {
  const r = record(
    ["fedify", "federation", "outbox"],
    "Failed to send activity {activityId} to {inbox} (attempt " +
      "#{attempt}); retry...:\n{error}",
    {
      error: denoFetchError("dns error: failed to lookup address information"),
    },
  );
  assert.equal(isRoutineFederationError(r), true);
});

test("outbox: keeps an unexpected handler error", () => {
  const r = record(
    ["fedify", "federation", "outbox"],
    "An unexpected error occurred in onError handler:\n{error}",
    { error: new TypeError("boom") },
  );
  assert.equal(isRoutineFederationError(r), false);
});

test("inbox: drops a processing failure caused by a remote fetch error", () => {
  const r = record(
    ["fedify", "federation", "inbox"],
    "Failed to process the incoming activity {activityId} (attempt " +
      "#{attempt}); retry...:\n{error}",
    { error: fetchError() },
  );
  assert.equal(isRoutineFederationError(r), true);
});

test("inbox: drops a processing failure caused by a transport error", () => {
  const r = record(
    ["fedify", "federation", "inbox"],
    "Failed to process the incoming activity {activityId} after {trial} " +
      "attempts; giving up:\n{error}",
    { error: denoFetchError("client error (Connect): received fatal alert") },
  );
  assert.equal(isRoutineFederationError(r), true);
});

test("inbox: KEEPS a processing failure caused by an app/listener bug", () => {
  const r = record(
    ["fedify", "federation", "inbox"],
    "Failed to process the incoming activity {activityId} (attempt " +
      "#{attempt}); retry...:\n{error}",
    {
      error: new TypeError("Cannot read properties of undefined (reading 'x')"),
    },
  );
  assert.equal(isRoutineFederationError(r), false);
});

test("inbox: keeps a processing failure caused by a database error", () => {
  const dbError = new Error("duplicate key value violates unique constraint");
  dbError.name = "PostgresError";
  const r = record(
    ["fedify", "federation", "inbox"],
    "Failed to process the incoming activity {activityId} (attempt " +
      "#{attempt}); retry...:\n{error}",
    { error: dbError },
  );
  assert.equal(isRoutineFederationError(r), false);
});

test("inbox: keeps a processing failure with no error attached", () => {
  const r = record(
    ["fedify", "federation", "inbox"],
    "Failed to process the incoming activity {activityId} (attempt " +
      "#{attempt}); retry...:\n{error}",
  );
  assert.equal(isRoutineFederationError(r), false);
});

test("inbox: keeps an unsupported activity type", () => {
  const r = record(
    ["fedify", "federation", "inbox"],
    "Unsupported activity type:\n{activity}",
    { error: fetchError() },
  );
  assert.equal(isRoutineFederationError(r), false);
});

test("vocab: drops a suppressed fetch failure (HTTP 403 followers)", () => {
  const error = new Error(
    "https://yodangang.express/users/x/followers: HTTP 403: " +
      "https://yodangang.express/users/x/followers",
  );
  error.name = "FetchError";
  const r = record(
    ["fedify", "vocab"],
    "Failed to fetch {url}: {error}",
    { url: "https://yodangang.express/users/x/followers", error },
  );
  assert.equal(isRoutineFederationError(r), true);
});

test("vocab: drops a suppressed fetch failure caused by transport error", () => {
  const r = record(
    ["fedify", "vocab"],
    "Failed to fetch {url}: {error}",
    {
      url: "https://dead.example/users/x/followers",
      error: denoFetchError("dns error"),
    },
  );
  assert.equal(isRoutineFederationError(r), true);
});

test("vocab: keeps a suppressed parse failure (malformed remote JSON-LD)", () => {
  const r = record(
    ["fedify", "vocab"],
    "Failed to parse {url}: {error}",
    { url: "https://example/x", error: new SyntaxError("Unexpected token") },
  );
  assert.equal(isRoutineFederationError(r), false);
});

test("vocab: keeps a fetch failure whose error is not remote/transport", () => {
  const r = record(
    ["fedify", "vocab"],
    "Failed to fetch {url}: {error}",
    { url: "https://example/x", error: new TypeError("ordinary bug") },
  );
  assert.equal(isRoutineFederationError(r), false);
});

test("keeps non-fedify error records", () => {
  const r = record(
    ["hackerspub", "graphql"],
    "Failed to send activity to {inbox}",
    { error: denoFetchError("dns error") },
  );
  assert.equal(isRoutineFederationError(r), false);
});

test("keeps an unknown fedify federation subcategory", () => {
  const r = record(
    ["fedify", "federation", "queue"],
    "Failed to send activity {activityId} to {inbox}:\n{error}",
    { error: denoFetchError("dns error") },
  );
  // Only outbox/inbox are matched; other federation subcategories pass through.
  assert.equal(isRoutineFederationError(r), false);
});

test("isRemoteTransportError: positive signals", () => {
  assert.equal(isRemoteTransportError(fetchError()), true);
  assert.equal(isRemoteTransportError(denoFetchError("dns error")), true);
});

test("isRemoteTransportError: negative signals", () => {
  assert.equal(isRemoteTransportError(new TypeError("ordinary bug")), false);
  assert.equal(isRemoteTransportError(new Error("whatever")), false);
  assert.equal(isRemoteTransportError(null), false);
  assert.equal(isRemoteTransportError(undefined), false);
  assert.equal(isRemoteTransportError("error sending request for url"), false);
  // A non-`TypeError` whose message merely starts with the fetch-error text
  // must still be kept (it is not the Deno transport-error shape).
  assert.equal(
    isRemoteTransportError(
      new Error("error sending request for url (x): nope"),
    ),
    false,
  );
});
