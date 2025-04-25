import type { Database } from "@hackerspub/models/db";
import { DatabaseLogger } from "@hackerspub/models/dblogger";
import { relations } from "@hackerspub/models/relations";
import * as drizzleSchema from "@hackerspub/models/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import { execute } from "graphql";
import { createYoga, type Plugin as EnvelopPlugin } from "graphql-yoga";
import postgresJs from "postgres";
import "./logging.ts";
import { schema as graphqlSchema } from "./mod.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (DATABASE_URL == null) {
  throw new Error("Missing DATABASE_URL environment variable.");
}

export const postgres = postgresJs(DATABASE_URL);
export const db: Database = drizzle({
  schema: drizzleSchema,
  relations,
  client: postgres,
  logger: new DatabaseLogger(),
});

const yoga = createYoga({
  schema: graphqlSchema,
  context: () => ({
    drizzle: db,
    moderator: true,
  }),
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

Deno.serve(yoga.fetch);
