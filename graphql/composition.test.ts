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

test("the queue worker migrates legacy deliveries before listening", async () => {
  const source = await readTextFile(new URL("worker.ts", import.meta.url));
  const migration = "await migrateLegacyOutboxEvents(db);";
  const queueStart = "federation.startQueue(";

  assertStringIncludes(source, migration);
  assertStringIncludes(source, queueStart);
  assert(
    source.indexOf(migration) < source.indexOf(queueStart),
    "legacy outgoing messages must migrate before the queue starts",
  );
});
