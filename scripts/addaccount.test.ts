import { assert, assertEquals, assertMatch } from "@std/assert";

Deno.test("addaccount initializes only its origin and key-value resources", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "scripts/addaccount.ts",
        "alice@example.com",
      ],
      cwd: new URL("../", import.meta.url),
      clearEnv: true,
      env: {
        ORIGIN: "https://hackers.pub",
        KV_URL: new URL("signup.json", `file://${directory}/`).href,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(
      output.success,
      true,
      new TextDecoder().decode(output.stderr),
    );
    const stdout = new TextDecoder().decode(output.stdout).trim();
    assertMatch(
      stdout,
      /^https:\/\/hackers\.pub\/sign\/up\/[0-9a-f-]+\?code=.+$/,
    );
    assert(
      !new TextDecoder().decode(output.stderr).includes("Error creating"),
      "the operational command should create a sign-up link",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
