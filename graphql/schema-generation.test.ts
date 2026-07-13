import assert from "node:assert";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateSchema } from "./generate-schema.ts";

const repositoryRoot = new URL("../", import.meta.url);
const rootConfig = new URL("deno.json", repositoryRoot);
const schemaModule = new URL("graphql/mod.ts", repositoryRoot);

test("runtime schema can be imported without write access", async () => {
  const source = `await import(${JSON.stringify(schemaModule.href)});`;
  const entrypoint = `data:application/typescript,${
    encodeURIComponent(source)
  }`;
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      fileURLToPath(rootConfig),
      "--cached-only",
      "--allow-all",
      "--deny-write",
      entrypoint,
    ],
    cwd: repositoryRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();

  assert.equal(
    output.success,
    true,
    new TextDecoder().decode(output.stderr),
  );
});

test("explicit schema generation is deterministic", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const firstOutput = pathToFileURL(join(directory, "schema-1.graphql"));
    const secondOutput = pathToFileURL(join(directory, "schema-2.graphql"));

    await generateSchema(firstOutput);
    await generateSchema(secondOutput);

    const checkedInSchema = await Deno.readTextFile(
      new URL("schema.graphql", import.meta.url),
    );
    assert.equal(await Deno.readTextFile(firstOutput), checkedInSchema);
    assert.equal(await Deno.readTextFile(secondOutput), checkedInSchema);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
