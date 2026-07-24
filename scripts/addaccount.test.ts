import { assert, assertEquals, assertMatch } from "@std/assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

test("addaccount initializes only its origin and key-value resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-addaccount-"));
  try {
    const output = spawnSync(
      process.execPath,
      [
        "--import",
        "temporal-polyfill/global",
        "scripts/addaccount.ts",
        "alice@example.com",
      ],
      {
        cwd: new URL("../", import.meta.url),
        env: {
          ORIGIN: "https://hackers.pub",
          KV_URL: new URL("signup.json", `file://${directory}/`).href,
        },
        encoding: "utf8",
      },
    );

    assertEquals(output.status, 0, output.stderr);
    const stdout = output.stdout.trim();
    assertMatch(
      stdout,
      /^https:\/\/hackers\.pub\/sign\/up\/[0-9a-f-]+\?code=.+$/,
    );
    assert(
      !output.stderr.includes("Error creating"),
      "the operational command should create a sign-up link",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
