import { type GraphQLSchema, printSchema } from "graphql";
import path from "node:path";
import "./account.ts";
import "./actor.ts";
import { builder } from "./builder.ts";

export const schema: GraphQLSchema = builder.toSchema();
export { createYogaServer } from "./server.ts";

void Deno.writeTextFile(
  path.join(import.meta.dirname ?? "", "schema.graphql"),
  printSchema(schema),
);
