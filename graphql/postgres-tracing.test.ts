import assert from "node:assert";
import { execFile } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

// Backport regression: https://github.com/getsentry/sentry-javascript/pull/21364
for (const format of ["esm", "cjs"]) {
  for (const path of ["wrapped", "fallback"]) {
    test(`Postgres tracing emits one span per execution with ${format} ${path}`, async () => {
      const { stdout } = await run(
        process.execPath,
        [
          fileURLToPath(
            new URL("./fixtures/postgres-tracing.ts", import.meta.url),
          ),
          format,
          path,
        ],
        { timeout: 10_000 },
      );
      const result = JSON.parse(stdout);
      assert.deepEqual(result.physical, { success: 1, failure: 1 });
      assert.deepEqual(result.values, [1, 1, 1]);
      assert.deepEqual(result.failures, ["42703", "42703", "42703"]);
      assert.deepEqual(result.spans, { success: 1, failure: 1 });
    });
  }
}
