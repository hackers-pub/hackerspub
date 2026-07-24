import { assertEquals, assertInstanceOf } from "@std/assert";
import { MockTransport } from "@upyo/mock";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createEmailResource,
  createKeyValueResource,
  FILE_SYSTEM_STORAGE_BASE_URL,
  getFederationBehaviorOptions,
  resolveFileSystemStorageLocation,
  runWithFederationQueue,
} from "./resources.ts";

test("resolveFileSystemStorageLocation resolves relative paths from the composition root", () => {
  assertEquals(
    resolveFileSystemStorageLocation("./media", new URL("file:///app/")).href,
    "file:///app/media",
  );
});

test("filesystem storage uses the application media root across processes", () => {
  assertEquals(
    resolveFileSystemStorageLocation("./media", FILE_SYSTEM_STORAGE_BASE_URL)
      .href,
    new URL("../media", import.meta.url).href,
  );
});

test("createKeyValueResource decodes file URL paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-resources-"));
  const filename = join(directory, "cache file.json");
  const kv = createKeyValueResource({ url: pathToFileURL(filename) });
  try {
    await kv.set("key", "value");
    assertEquals(await kv.get("key"), "value");
    await stat(filename);
  } finally {
    await kv.disconnect();
    await rm(directory, { recursive: true });
  }
});

test("getFederationBehaviorOptions supports an explicitly managed queue", () => {
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

test("runWithFederationQueue aborts and awaits the queue before returning", async () => {
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

  assertEquals(events, ["queue-started", "server-stopped", "queue-stopped"]);
});

test("runWithFederationQueue accepts Error-shaped abort failures", async () => {
  const federation = {
    startQueue(
      _contextData: undefined,
      options?: { signal?: AbortSignal },
    ): Promise<void> {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          const error = new Error("Queue aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    },
  };

  await runWithFederationQueue(federation, undefined, () => Promise.resolve());
});

test("runWithFederationQueue stops both tasks on an external signal", async () => {
  const controller = new AbortController();
  const queueStarted = Promise.withResolvers<void>();
  const serverStarted = Promise.withResolvers<void>();
  const federation = {
    startQueue(
      _contextData: undefined,
      options?: { signal?: AbortSignal },
    ): Promise<void> {
      queueStarted.resolve();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          const error = new Error("Queue aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    },
  };

  const running = runWithFederationQueue(
    federation,
    undefined,
    (signal) => {
      serverStarted.resolve();
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve());
      });
    },
    { signal: controller.signal },
  );
  await Promise.all([queueStarted.promise, serverStarted.promise]);
  controller.abort();

  await running;
});

test("createEmailResource warns when Mailgun is unconfigured", () => {
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

test("createEmailResource does not warn when CI selects the mock transport", () => {
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
