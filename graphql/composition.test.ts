import { assert, assertStringIncludes } from "@std/assert";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readTextFile = (path: string | URL) => readFile(path, "utf8");

for (const [compositionRoot, role] of [
  ["main.ts", "API"],
  ["worker.ts", "worker"],
] as const) {
  test(`the ${role} preloads Sentry before evaluating its module graph`, async () => {
    const [source, tasks] = await Promise.all([
      readTextFile(new URL(compositionRoot, import.meta.url)),
      readTextFile(new URL("../mise.toml", import.meta.url)),
    ]);
    const loggingImport = 'import "./logging.ts";';
    const preload = `--import ./instrument.ts ${compositionRoot}`;

    assertStringIncludes(source, loggingImport);
    assertStringIncludes(tasks, preload);
    assert(
      tasks.indexOf("--import ./instrument.ts") <
        tasks.indexOf(compositionRoot),
      `Sentry instrumentation must be preloaded before the ${role} entrypoint`,
    );
  });
}

test("the API owns unhandled rejection classification", async () => {
  const instrument = await readTextFile(
    new URL("instrument.ts", import.meta.url),
  );

  assertStringIncludes(
    instrument,
    'integration.name !== "OnUnhandledRejection"',
  );
  assertStringIncludes(instrument, 'process.on("unhandledRejection"');
  assertStringIncludes(instrument, "reportUnhandledRejection(");
});

for (const [compositionRoot, role] of [
  ["main.ts", "API"],
  ["worker.ts", "worker"],
] as const) {
  test(`the ${role} bounds Sentry shutdown flushing`, async () => {
    const source = await readTextFile(
      new URL(compositionRoot, import.meta.url),
    );

    assertStringIncludes(source, "const SENTRY_CLOSE_TIMEOUT = 2_000;");
    assertStringIncludes(source, "await Sentry.close(SENTRY_CLOSE_TIMEOUT);");
  });
}

test("empty Sentry DSNs do not enable shared integrations", async () => {
  const [logging, server] = await Promise.all([
    readTextFile(new URL("logging-config.ts", import.meta.url)),
    readTextFile(new URL("server.ts", import.meta.url)),
  ]);

  assertStringIncludes(
    logging,
    "const sentryEnabled = Boolean(environment.SENTRY_DSN);",
  );
  assertStringIncludes(
    server,
    "const sentryEnabled = Boolean(process.env.SENTRY_DSN);",
  );
});

test("the queue worker migrates legacy deliveries before listening", async () => {
  const source = await readTextFile(new URL("worker.ts", import.meta.url));
  const migration = "await migrateLegacyOutboxEvents(db);";
  const queueStart = "runWorkerRuntime(";

  assertStringIncludes(source, migration);
  assertStringIncludes(source, queueStart);
  assert(
    source.indexOf(migration) < source.indexOf(queueStart),
    "legacy outgoing messages must migrate before worker.ts starts the queue",
  );
});
