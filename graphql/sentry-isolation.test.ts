import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import process from "node:process";
import test from "node:test";

test(
  "preloaded Sentry isolates concurrent Node HTTP users",
  { skip: "Deno" in globalThis },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "./graphql/instrument.node.ts",
        "./graphql/sentry-isolation.fixture.ts",
      ],
      {
        cwd: new URL("../", import.meta.url),
        env: {
          ...process.env,
          SENTRY_DSN: "https://public@example.invalid/1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });

    assert.equal(
      exitCode,
      0,
      `Sentry isolation fixture failed:\n${Buffer.concat(stderr).toString()}`,
    );
    assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString()), {
      concurrent: ["alice", "bob"],
      guest: "anonymous",
    });
  },
);
