import { assert, assertStringIncludes } from "@std/assert";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readTextFile = (path: string | URL) => readFile(path, "utf8");

for (const compositionRoot of ["main.ts", "worker.ts"]) {
  test(`${compositionRoot} initializes LogTape after Sentry instrumentation`, async () => {
    const source = await readTextFile(
      new URL(compositionRoot, import.meta.url),
    );
    const instrumentImport = 'import "./instrument.ts";';
    const loggingImport = 'import "./logging.ts";';

    assertStringIncludes(source, instrumentImport);
    assertStringIncludes(source, loggingImport);
    assert(
      source.indexOf(instrumentImport) < source.indexOf(loggingImport),
      "Sentry instrumentation must run before LogTape configuration",
    );
  });
}

for (const [compositionRoot, role] of [
  ["main.node.ts", "API"],
  ["worker.node.ts", "worker"],
] as const) {
  test(`the Node ${role} preloads Sentry before evaluating its module graph`, async () => {
    const [source, tasks] = await Promise.all([
      readTextFile(new URL(compositionRoot, import.meta.url)),
      readTextFile(new URL("../mise.toml", import.meta.url)),
    ]);
    const loggingImport = 'import "./logging.node.ts";';
    const preload = `--import ./instrument.node.ts ${compositionRoot}`;

    assertStringIncludes(source, loggingImport);
    assertStringIncludes(tasks, preload);
    assert(
      tasks.indexOf("--import ./instrument.node.ts") <
        tasks.indexOf(compositionRoot),
      `Node Sentry instrumentation must be preloaded before the ${role} entrypoint`,
    );
  });
}

test("the Node API owns unhandled rejection classification", async () => {
  const instrument = await readTextFile(
    new URL("instrument.node.ts", import.meta.url),
  );

  assertStringIncludes(
    instrument,
    'integration.name !== "OnUnhandledRejection"',
  );
  assertStringIncludes(instrument, 'process.on("unhandledRejection"');
  assertStringIncludes(instrument, "reportUnhandledRejection(");
});

for (const [compositionRoot, role] of [
  ["main.node.ts", "API"],
  ["worker.node.ts", "worker"],
] as const) {
  test(`the Node ${role} bounds Sentry shutdown flushing`, async () => {
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
  for (const [compositionRoot, queueStart] of [
    ["worker.ts", "federation.startQueue("],
    ["worker.node.ts", "runWorkerRuntime("],
  ] as const) {
    const source = await readTextFile(
      new URL(compositionRoot, import.meta.url),
    );
    const migration = "await migrateLegacyOutboxEvents(db);";

    assertStringIncludes(source, migration);
    assertStringIncludes(source, queueStart);
    assert(
      source.indexOf(migration) < source.indexOf(queueStart),
      `legacy outgoing messages must migrate before ${compositionRoot} starts the queue`,
    );
  }
});
