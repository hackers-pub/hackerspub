import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("production main composes protocol bounds and permanent admission readiness", async () => {
  for (const role of ["protocol", "interactive"]) {
    const { stderr } = await execute(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--import",
        "temporal-polyfill/global",
        fileURLToPath(
          new URL("../test/http-main-wiring-process.ts", import.meta.url),
        ),
        role,
      ],
      { env: { ...process.env, SENTRY_DSN: "" }, timeout: 10000 },
    );
    assert.ok(!stderr.includes("AssertionError"), stderr);
  }
});

test("production main rejects a failed admission store before serving", async () => {
  for (const role of ["interactive", "combined"]) {
    for (const failure of [
      "ledger_missing_or_mismatched",
      "redis_connect_failed",
      "redis_command_failed",
    ]) {
      const { stderr } = await execute(
        process.execPath,
        [
          "--experimental-test-module-mocks",
          "--import",
          "temporal-polyfill/global",
          fileURLToPath(
            new URL("../test/http-main-wiring-process.ts", import.meta.url),
          ),
          role,
          failure,
        ],
        { env: { ...process.env, SENTRY_DSN: "" }, timeout: 10000 },
      );
      assert.ok(!stderr.includes("AssertionError"), stderr);
    }
  }
});
