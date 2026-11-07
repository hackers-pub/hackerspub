import assert from "node:assert";
import test from "node:test";
import {
  getSsrGraphQLDeadline,
  startSsrGraphQLBudget,
} from "./ssrGraphQLBudget.ts";

test("SSR GraphQL budget: middleware start includes time before the first operation", (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const locals = {};
  startSsrGraphQLBudget(locals);
  now = 350;
  assert.equal(getSsrGraphQLDeadline(locals, 1000), 1100);
});

test("SSR GraphQL budget: sequential operations never reset the event deadline", (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const locals = {};
  const first = getSsrGraphQLDeadline(locals, 1000);
  now = 600;
  startSsrGraphQLBudget(locals);
  assert.equal(getSsrGraphQLDeadline(locals, 5000), first);
  now = 1200;
  assert.equal(getSsrGraphQLDeadline(locals, 5000), first);
  assert.ok(first < performance.now());
});

test("SSR GraphQL budget: event clones sharing locals keep the same budget", (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const event = { locals: {} };
  const clone = { ...event };
  const first = getSsrGraphQLDeadline(event.locals, 1000);
  now = 500;
  assert.equal(getSsrGraphQLDeadline(clone.locals, 1000), first);
});

test("SSR GraphQL budget: separate requests have independent start times", (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const first = {};
  const second = {};
  startSsrGraphQLBudget(first);
  now = 500;
  startSsrGraphQLBudget(second);
  assert.equal(getSsrGraphQLDeadline(first, 1000), 1100);
  assert.equal(getSsrGraphQLDeadline(second, 1000), 1500);
});

test("SSR GraphQL budget: timestamp recording does not validate SSR settings or allocate timers", (t) => {
  const original = process.env.WEB_SSR_GRAPHQL_TIMEOUT_MS;
  process.env.WEB_SSR_GRAPHQL_TIMEOUT_MS = "invalid";
  t.after(() => {
    if (original === undefined) delete process.env.WEB_SSR_GRAPHQL_TIMEOUT_MS;
    else process.env.WEB_SSR_GRAPHQL_TIMEOUT_MS = original;
  });
  t.mock.method(performance, "now", () => 100);
  t.mock.method(globalThis, "setTimeout", () => {
    throw new Error("unexpected timer");
  });
  const locals = { session: "unchanged", ssrGraphQLBudget: "unrelated value" };
  startSsrGraphQLBudget(locals);
  assert.equal(locals.session, "unchanged");
  assert.equal(locals.ssrGraphQLBudget, "unrelated value");
  assert.equal(getSsrGraphQLDeadline(locals, 1000), 1100);
});
