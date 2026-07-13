import { assertEquals, assertInstanceOf } from "@std/assert";
import { MockTransport } from "@upyo/mock";
import {
  createEmailResource,
  getFederationBehaviorOptions,
  resolveFileSystemStorageLocation,
  runWithFederationQueue,
} from "./resources.ts";

Deno.test("resolveFileSystemStorageLocation resolves relative paths from the composition root", () => {
  assertEquals(
    resolveFileSystemStorageLocation(
      "./media",
      new URL("file:///app/web/"),
    ).href,
    "file:///app/web/media",
  );
});

Deno.test("getFederationBehaviorOptions supports an explicitly managed legacy queue", () => {
  assertEquals(
    getFederationBehaviorOptions({
      manuallyStartQueue: true,
      firstKnock: "draft-cavage-http-signatures-12",
    }),
    {
      manuallyStartQueue: true,
      firstKnock: "draft-cavage-http-signatures-12",
    },
  );
});

Deno.test("runWithFederationQueue aborts and awaits the queue before returning", async () => {
  const events: string[] = [];
  const federation = {
    startQueue(
      _contextData: undefined,
      options?: { signal?: AbortSignal },
    ): Promise<void> {
      events.push("queue-started");
      return new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () => {
          events.push("queue-stopped");
          resolve();
        });
      });
    },
  };

  await runWithFederationQueue(federation, undefined, async (signal) => {
    assertEquals(signal.aborted, false);
    events.push("server-stopped");
  });

  assertEquals(events, [
    "queue-started",
    "server-stopped",
    "queue-stopped",
  ]);
});

Deno.test("createEmailResource warns when Mailgun is unconfigured", () => {
  const warnings: string[] = [];
  const transport = createEmailResource(
    {
      transport: "mock",
      from: "noreply@hackers.pub",
      reason: "mailgun-unconfigured",
    },
    {
      warning(message) {
        warnings.push(message);
      },
    },
  );

  assertInstanceOf(transport, MockTransport);
  assertEquals(warnings, [
    "MAILGUN_* environment variables are not configured; using MockTransport. Emails will not be delivered.",
  ]);
});

Deno.test("createEmailResource does not warn when CI selects the mock transport", () => {
  const warnings: string[] = [];
  createEmailResource(
    {
      transport: "mock",
      from: "noreply@hackers.pub",
      reason: "ci",
    },
    {
      warning(message) {
        warnings.push(message);
      },
    },
  );

  assertEquals(warnings, []);
});
