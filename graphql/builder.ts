import type { RequestContext } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import type { Database } from "@hackerspub/models/db";
import { relations } from "@hackerspub/models/relations";
import type { Session } from "@hackerspub/models/session";
import type { Uuid } from "@hackerspub/models/uuid";
import SchemaBuilder from "@pothos/core";
import ComplexityPlugin from "@pothos/plugin-complexity";
import DrizzlePlugin from "@pothos/plugin-drizzle";
import RelayPlugin from "@pothos/plugin-relay";
import ScopeAuthPlugin from "@pothos/plugin-scope-auth";
import SimpleObjectsPlugin from "@pothos/plugin-simple-objects";
import TracingPlugin from "@pothos/plugin-tracing";
import WithInputPlugin from "@pothos/plugin-with-input";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Disk } from "flydrive";
import { GraphQLScalarType, Kind } from "graphql";
import {
  DateResolver,
  DateTimeResolver,
  JSONResolver,
  URLResolver,
  UUIDResolver,
} from "graphql-scalars";
import { createGraphQLError } from "graphql-yoga";
import type Keyv from "keyv";

export interface Context {
  db: Database;
  kv: Keyv;
  disk: Disk;
  fedCtx: RequestContext<ContextData>;
  moderator: boolean;
  session: Promise<Session | undefined> | undefined;
}

export interface PothosTypes {
  DefaultFieldNullability: false;
  DrizzleRelations: typeof relations;
  Context: Context;
  AuthScopes: {
    signed: boolean;
    moderator: boolean;
    selfAccount: Uuid;
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
    Locale: {
      Input: Intl.Locale;
      Output: Intl.Locale;
    };
    HTML: {
      Input: string;
      Output: string;
    };
    JSON: {
      Input: unknown;
      Output: unknown;
    };
    Markdown: {
      Input: string;
      Output: string;
    };
    MediaType: {
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
    ComplexityPlugin,
    RelayPlugin,
    ScopeAuthPlugin,
    DrizzlePlugin,
    SimpleObjectsPlugin,
    TracingPlugin,
    WithInputPlugin,
  ],
  complexity: {
    defaultComplexity: 1,
    defaultListMultiplier: 10,
    limit(ctx) {
      if (ctx.moderator) {
        return {
          complexity: 1000,
          depth: 20,
          breadth: 200,
        };
      }
      return {
        complexity: 500,
        depth: 10,
        breadth: 100,
      };
    },
  },
  defaultFieldNullability: false,
  drizzle: {
    client: (ctx) => ctx.db,
    getTableConfig,
    relations,
  },
  scopeAuth: {
    authScopes: (ctx) => ({
      signed: ctx.session != null,
      moderator: ctx.moderator,
      selfAccount: async (id) => id === (await ctx.session)?.accountId,
    }),
  },
  relay: {
    clientMutationId: "optional",
  },
});

builder.addScalarType("Date", DateResolver);
builder.addScalarType("DateTime", DateTimeResolver);

builder.addScalarType(
  "Locale",
  new GraphQLScalarType<Intl.Locale, string>({
    name: "Locale",
    description: "A BCP 47-compliant language tag.",
    serialize(value) {
      if (typeof value === "string") {
        try {
          value = new Intl.Locale(value);
        } catch {
          throw createGraphQLError(`Invalid locale string: ${value}`);
        }
      }
      if (value instanceof Intl.Locale) {
        return value.baseName;
      } else {
        throw createGraphQLError(
          `Expected Intl.Locale but got: ${typeof value}`,
        );
      }
    },
    parseValue(value) {
      if (!(typeof value === "string")) {
        throw createGraphQLError(
          `Expected string for locale but got: ${typeof value}`,
        );
      }
      try {
        return new Intl.Locale(value);
      } catch {
        throw createGraphQLError(`Invalid locale string: ${value}`);
      }
    },
    parseLiteral(ast) {
      if (ast.kind !== Kind.STRING) {
        throw createGraphQLError(
          `Can only validate strings as locales but got a: ${ast.kind}`,
          { nodes: ast },
        );
      }
      const { value } = ast;
      try {
        return new Intl.Locale(value);
      } catch {
        throw createGraphQLError(`Invalid locale string: ${value}`, {
          nodes: ast,
        });
      }
    },
    extensions: {
      codegenScalarType: "Intl.Locale | string",
      jsonSchema: {
        type: "string",
      },
    },
  }),
);

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

builder.addScalarType("JSON", JSONResolver);

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

builder.scalarType("MediaType", {
  serialize: (v) => v,
  parseValue: (v) => String(v),
});

builder.queryType({});
builder.mutationType({});

export const Node = builder.nodeInterfaceRef();
