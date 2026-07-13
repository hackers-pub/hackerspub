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
