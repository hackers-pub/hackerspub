import { printSchema } from "graphql";
import { schema } from "./mod.ts";

export async function generateSchema(
  output: URL = new URL("schema.graphql", import.meta.url),
): Promise<void> {
  await Deno.writeTextFile(output, printSchema(schema));
}

if (import.meta.main) await generateSchema();
