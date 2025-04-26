import type { Database } from "@hackerspub/models/db";
import { relations } from "@hackerspub/models/relations";
import SchemaBuilder from "@pothos/core";
import DrizzlePlugin from "@pothos/plugin-drizzle";
import RelayPlugin from "@pothos/plugin-relay";
import ScopeAuthPlugin from "@pothos/plugin-scope-auth";
import TracingPlugin from "@pothos/plugin-tracing";
import WithInputPlugin from "@pothos/plugin-with-input";
import { getTableConfig } from "drizzle-orm/pg-core";

export interface PothosTypes {
  DefaultFieldNullability: false;
  DrizzleRelations: typeof relations;
  Context: {
    drizzle: Database;
    moderator: boolean;
  };
  AuthScopes: {
    moderator: boolean;
  };
}

export const builder = new SchemaBuilder<PothosTypes>({
  plugins: [
    RelayPlugin,
    ScopeAuthPlugin,
    DrizzlePlugin,
    TracingPlugin,
    WithInputPlugin,
  ],
  defaultFieldNullability: false,
  drizzle: {
    client: (ctx) => ctx.drizzle,
    getTableConfig,
    relations,
  },
  scopeAuth: {
    authScopes: (ctx) => ({
      moderator: ctx.moderator,
    }),
  },
});

builder.queryType({});
// builder.mutationType({});
