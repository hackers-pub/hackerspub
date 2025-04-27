import type { Context as FedContext } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import type { Database } from "@hackerspub/models/db";
import { relations } from "@hackerspub/models/relations";
import type { Uuid } from "@hackerspub/models/uuid";
import SchemaBuilder from "@pothos/core";
import DrizzlePlugin from "@pothos/plugin-drizzle";
import RelayPlugin from "@pothos/plugin-relay";
import ScopeAuthPlugin from "@pothos/plugin-scope-auth";
import TracingPlugin from "@pothos/plugin-tracing";
import WithInputPlugin from "@pothos/plugin-with-input";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Disk } from "flydrive";
import { GraphQLScalarType, Kind } from "graphql";
import {
  DateResolver,
  DateTimeResolver,
  URLResolver,
  UUIDResolver,
} from "graphql-scalars";
import { createGraphQLError } from "graphql-yoga";
import type Keyv from "keyv";

export interface Context {
  db: Database;
  kv: Keyv;
  disk: Disk;
  fedCtx: FedContext<ContextData>;
  moderator: boolean;
}

export interface PothosTypes {
  DefaultFieldNullability: false;
  DrizzleRelations: typeof relations;
  Context: Context;
  AuthScopes: {
    moderator: boolean;
  };
  Scalars: {
    Date: {
      Input: Date;
      Output: Date;
    };
    DateTime: {
      Input: Date;
      Output: Date;
    };
    HTML: {
      Input: string;
      Output: string;
    };
    Markdown: {
      Input: string;
      Output: string;
    };
    URL: {
      Input: URL;
      Output: URL;
    };
    UUID: {
      Input: Uuid;
      Output: Uuid;
    };
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
    client: (ctx) => ctx.db,
    getTableConfig,
    relations,
  },
  scopeAuth: {
    authScopes: (ctx) => ({
      moderator: ctx.moderator,
    }),
  },
});

builder.addScalarType("Date", DateResolver);
builder.addScalarType("DateTime", DateTimeResolver);

builder.addScalarType(
  "HTML",
  new GraphQLScalarType({
    name: "HTML",
    description: "An HTML string.",
    serialize(value) {
      return value;
    },
    parseValue(value) {
      return value;
    },
    parseLiteral(ast) {
      if (ast.kind !== Kind.STRING) {
        throw createGraphQLError(
          `Can only validate strings as HTMLs but got a: ${ast.kind}`,
          { nodes: ast },
        );
      }
      return ast.value;
    },
    extensions: {
      codegenScalarType: "string",
      jsonSchema: {
        type: "string",
      },
    },
  }),
);

builder.addScalarType(
  "Markdown",
  new GraphQLScalarType({
    name: "Markdown",
    description: "A Hackers' Pub-flavored Markdown text.",
    serialize(value) {
      return value;
    },
    parseValue(value) {
      return value;
    },
    parseLiteral(ast) {
      if (ast.kind !== Kind.STRING) {
        throw createGraphQLError(
          `Can only validate strings as Markdowns but got a: ${ast.kind}`,
          { nodes: ast },
        );
      }
      return ast.value;
    },
    extensions: {
      codegenScalarType: "string",
      jsonSchema: {
        type: "string",
      },
    },
  }),
);

builder.addScalarType("URL", URLResolver);
builder.addScalarType("UUID", UUIDResolver);

builder.queryType({});
// builder.mutationType({});
