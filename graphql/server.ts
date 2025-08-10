import type { Account, Actor } from "@hackerspub/models/schema";
import { getSession } from "@hackerspub/models/session";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { getCookies } from "@std/http/cookie";
import { execute } from "graphql";
import {
  createYoga,
  type Plugin as EnvelopPlugin,
  type YogaServerInstance,
} from "graphql-yoga";
import type { ServerContext, UserContext } from "./builder.ts";
import { schema as graphqlSchema } from "./mod.ts";

export function createYogaServer(): YogaServerInstance<
  ServerContext,
  UserContext
> {
  return createYoga({
    schema: graphqlSchema,
    context: async (ctx) => {
      const { request: req, db, kv } = ctx;
      let sessionId: Uuid | undefined = undefined;
      const authorization = req.headers.get("Authorization");
      if (authorization && authorization.startsWith("Bearer ")) {
        const uuid = authorization.slice(7).trim();
        if (validateUuid(uuid)) sessionId = uuid;
      }
      if (sessionId == null) {
        const cookies = getCookies(req.headers);
        if (validateUuid(cookies.session)) sessionId = cookies.session;
      }

      let session = sessionId == null
        ? undefined
        : await getSession(kv, sessionId);
      let account: Account & { actor: Actor } | undefined;

      if (session != null) {
        account = await db.query.accountTable.findFirst({
          where: { id: session.accountId },
          with: {
            actor: true,
          },
        });
        if (account == null) session = undefined;
      }

      return {
        session,
        account,
        ...ctx,
      };
    },
    plugins: [{
      onExecute: ({ setExecuteFn, context }) => {
        const isNoPropagate =
          new URL(context.request.url).searchParams.get("no-propagate") ===
            "true" ||
          context.request.headers.get("x-no-propagate") === "true";
        setExecuteFn((args) =>
          execute({
            ...args,
            onError: isNoPropagate ? "NO_PROPAGATE" : "PROPAGATE",
          })
        );
      },
    } as EnvelopPlugin],
  });
}
