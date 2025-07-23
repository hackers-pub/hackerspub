import type { RequestContext } from "@fedify/fedify";
import { normalizeEmail } from "@hackerspub/models/account";
import type { ContextData } from "@hackerspub/models/context";
import type { Database } from "@hackerspub/models/db";
import { relations } from "@hackerspub/models/relations";
import type { Account, Actor } from "@hackerspub/models/schema";
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
import type { Transport } from "@upyo/core";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Disk } from "flydrive";
import { GraphQLScalarType, Kind } from "graphql";
import {
  DateResolver,
  DateTimeResolver,
  IPResolver,
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
  email: Transport;
  fedCtx: RequestContext<ContextData>;
  session: Session | undefined;
  account: Account & { actor: Actor } | undefined;
  request: Request;
  connectionInfo?: Deno.ServeHandlerInfo<Deno.Addr>;
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
    Email: {
      Input: string;
      Output: string;
    };
    Locale: {
      Input: Intl.Locale;
      Output: Intl.Locale | string;
    };
    HTML: {
      Input: string;
      Output: string;
    };
    IP: {
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
    URITemplate: {
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
    limit: {
      complexity: 2500,
      depth: 10,
      breadth: 150,
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
      moderator: async () => {
        const accountId = ctx.session?.accountId;
        if (accountId == null) return false;
        const account = await ctx.db.query.accountTable.findFirst({
          where: { id: accountId },
          columns: { moderator: true },
        });
        return account?.moderator ?? false;
      },
      selfAccount: async (id) => id === ctx.session?.accountId,
    }),
  },
  relay: {
    clientMutationId: "optional",
  },
});

builder.addScalarType("Date", DateResolver);
builder.addScalarType("DateTime", DateTimeResolver);

builder.scalarType("Email", {
  serialize: (v) => normalizeEmail(v),
  parseValue: (v) => normalizeEmail(String(v)),
});

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

builder.addScalarType("IP", IPResolver);
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

builder.scalarType("URITemplate", {
  serialize: (v) => v,
  parseValue: (v) => String(v),
});

builder.addScalarType("URL", URLResolver);
builder.addScalarType("UUID", UUIDResolver);

builder.scalarType("MediaType", {
  serialize: (v) => v,
  parseValue: (v) => String(v),
});

builder.queryType({});
builder.mutationType({});

export const Node = builder.nodeInterfaceRef();
