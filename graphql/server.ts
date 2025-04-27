import { execute } from "graphql";
import {
  createYoga,
  type Plugin as EnvelopPlugin,
  type YogaServerInstance,
} from "graphql-yoga";
import type { Context } from "./builder.ts";
import { schema as graphqlSchema } from "./mod.ts";

export function createYogaServer(): YogaServerInstance<Context, Context> {
  return createYoga({
    schema: graphqlSchema,
    context: (ctx) => ctx,
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
