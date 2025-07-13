import { type GraphQLSchema, printSchema } from "graphql";
import path from "node:path";
import "./account.ts";
import "./actor.ts";
import { builder } from "./builder.ts";
import "./doc.ts";
import "./login.ts";
import "./poll.ts";
import "./post.ts";
import "./reactable.ts";
export type { Context } from "./builder.ts";
export { createYogaServer } from "./server.ts";

export const schema: GraphQLSchema = builder.toSchema();

void Deno.writeTextFile(
  path.join(import.meta.dirname ?? "", "schema.graphql"),
  printSchema(schema),
);
