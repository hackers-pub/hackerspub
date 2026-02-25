import { type GraphQLSchema, printSchema } from "graphql";
import path from "node:path";
import "./account.ts";
import "./actor.ts";
import { builder } from "./builder.ts";
import "./error.ts";
import "./doc.ts";
import "./invite.ts";
import "./login.ts";
import "./misc.ts";
import "./notification.ts";
import "./passkey.ts";
import "./poll.ts";
import "./post.ts";
import "./reactable.ts";
import "./search.ts";
import "./signup.ts";
import "./timeline.ts";
export type { UserContext as Context } from "./builder.ts";
export { createYogaServer } from "./server.ts";

export const schema: GraphQLSchema = builder.toSchema();

void Deno.writeTextFile(
  path.join(import.meta.dirname ?? "", "schema.graphql"),
  printSchema(schema),
);
