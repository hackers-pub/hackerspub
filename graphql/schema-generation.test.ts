import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { generateSchema } from "./generate-schema.ts";

const repositoryRoot = new URL("../", import.meta.url);
const schemaModule = new URL("graphql/mod.ts", repositoryRoot);

test(
  "runtime schema can be imported without write access",
  { skip: "Deno" in globalThis },
  async () => {
    const source = `await import(${JSON.stringify(schemaModule.href)});`;
    const output = spawnSync(
      process.execPath,
      [
        "--import",
        "temporal-polyfill/global",
        "--permission",
        "--allow-fs-read=*",
        "--allow-addons",
        "--input-type=module",
        "--eval",
        source,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    assert.equal(output.status, 0, output.stderr);
  },
);

test("explicit schema generation is deterministic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-schema-"));
  try {
    const firstOutput = pathToFileURL(join(directory, "schema-1.graphql"));
    const secondOutput = pathToFileURL(join(directory, "schema-2.graphql"));

    await generateSchema(firstOutput);
    await generateSchema(secondOutput);

    const checkedInSchema = await readFile(
      new URL("schema.graphql", import.meta.url),
      "utf8",
    );
    assert.equal(await readFile(firstOutput, "utf8"), checkedInSchema);
    assert.equal(await readFile(secondOutput, "utf8"), checkedInSchema);
  } finally {
    await rm(directory, { recursive: true });
  }
});
