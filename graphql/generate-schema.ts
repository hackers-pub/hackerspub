import { printSchema } from "graphql";
import { isMain } from "@hackerspub/runtime/main";
import { writeFile } from "node:fs/promises";
import { schema } from "./mod.ts";

export async function generateSchema(
  output: URL = new URL("schema.graphql", import.meta.url),
): Promise<void> {
  await writeFile(output, printSchema(schema));
}

if (isMain(import.meta)) await generateSchema();
