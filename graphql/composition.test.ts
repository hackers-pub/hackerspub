import { assert, assertStringIncludes } from "@std/assert";

for (const compositionRoot of ["main.ts", "worker.ts"]) {
  Deno.test(`${compositionRoot} initializes LogTape after Sentry instrumentation`, async () => {
    const source = await Deno.readTextFile(
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

Deno.test("the queue worker migrates legacy deliveries before listening", async () => {
  const source = await Deno.readTextFile(
    new URL("worker.ts", import.meta.url),
  );
  const migration = "await migrateLegacyOutboxEvents(db);";
  const queueStart = "await federation.startQueue(";

  assertStringIncludes(source, migration);
  assertStringIncludes(source, queueStart);
  assert(
    source.indexOf(migration) < source.indexOf(queueStart),
    "legacy outgoing messages must migrate before the queue starts",
  );
});
