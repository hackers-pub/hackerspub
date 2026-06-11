import { type GraphQLSchema, printSchema } from "graphql";
import path from "node:path";
import "./account.ts";
import "./admin.ts";
import "./actor.ts";
import { builder } from "./builder.ts";
import "./error.ts";
import "./doc.ts";
import "./apns.ts";
import "./fcm.ts";
import "./hashtag.ts";
import "./invite.ts";
import "./invitation-link.ts";
import "./login.ts";
import "./markdown.ts";
import "./misc.ts";
import "./moderation.ts";
import "./news.ts";
import "./notification.ts";
import "./passkey.ts";
import "./poll.ts";
import "./post.ts";
import "./push.ts";
import "./reactable.ts";
import "./refresh.ts";
import "./relay.ts";
import "./search.ts";
import "./signup.ts";
import "./timeline.ts";
import "./webfinger.ts";
export type { UserContext as Context } from "./builder.ts";
export { createYogaServer } from "./server.ts";

export const schema: GraphQLSchema = builder.toSchema();

void Deno.writeTextFile(
  path.join(import.meta.dirname ?? "", "schema.graphql"),
  printSchema(schema),
);
