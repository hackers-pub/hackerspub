import type { RequestContext } from "@fedify/fedify";
import SchemaBuilder from "@pothos/core";
import ComplexityPlugin from "@pothos/plugin-complexity";
import DataloaderPlugin from "@pothos/plugin-dataloader";
import DrizzlePlugin from "@pothos/plugin-drizzle";
import ErrorsPlugin from "@pothos/plugin-errors";
import RelayPlugin from "@pothos/plugin-relay";
import ScopeAuthPlugin from "@pothos/plugin-scope-auth";
import SimpleObjectsPlugin from "@pothos/plugin-simple-objects";
import TracingPlugin from "@pothos/plugin-tracing";
import WithInputPlugin from "@pothos/plugin-with-input";
import type { Transport } from "@upyo/core";
import { getColumns } from "drizzle-orm";
import { getTableConfig as _getTableConfig } from "drizzle-orm/pg-core";

// In drizzle-orm rc.2, getTableConfig().primaryKeys[].columns returns different
// column object instances than getColumns(). Pothos Drizzle plugin builds its
// columnNameMappings from getColumns(), so we patch getTableConfig to return
// the same column object references that getColumns() uses.
function getTableConfig(
  table: Parameters<typeof _getTableConfig>[0],
): ReturnType<typeof _getTableConfig> {
  const config = _getTableConfig(table);
  const cols = getColumns(table);
  const colByName = new Map(
    Object.values(cols).map((col) => [col.name, col]),
  );
  // columns is read-only, so we patch via Object.defineProperty
  config.primaryKeys.forEach((pk) => {
    Object.defineProperty(pk, "columns", {
      value: pk.columns.map((col) => colByName.get(col.name) ?? col),
      writable: true,
      configurable: true,
    });
  });
  return config;
}
import type DataLoader from "dataloader";
import type { Disk } from "flydrive";
import type { LanguageModel } from "ai";
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
import { normalizeEmail } from "@hackerspub/models/account";
import type { ContextData } from "@hackerspub/models/context";
import type { Database } from "@hackerspub/models/db";
import type { PostInteractionPolicy } from "@hackerspub/models/post";
import { relations } from "@hackerspub/models/relations";
import type {
  Account,
  AccountEmail,
  AccountLink,
  Actor,
  Medium,
} from "@hackerspub/models/schema";
import type { Session } from "@hackerspub/models/session";
import type { Uuid } from "@hackerspub/models/uuid";

export type ValuesOfEnumType<T> = T extends
  PothosSchemaTypes.EnumRef<never, unknown, infer V> ? V : never;

export interface ServerContext {
  altTextGenerator: LanguageModel;
  db: Database;
  kv: Keyv;
  disk: Disk;
  email: Transport;
  fedCtx: RequestContext<ContextData>;
  request: Request;
  connectionInfo?: Deno.ServeHandlerInfo<Deno.Addr>;
}

export interface AdminAccountStats {
  postCount: number;
  lastPostPublished: Date | null;
}

export interface UserContext extends ServerContext {
  session: Session | undefined;
  account:
    | Account & {
      actor: Actor;
      avatarMedium: Medium | null;
      emails: AccountEmail[];
      links: AccountLink[];
    }
    | undefined;
  pollViewerVotes?: Map<Uuid, Promise<ReadonlySet<number>>>;
  adminAccountStatsLoader?: DataLoader<Uuid, AdminAccountStats>;
  inviteeCountLoader?: DataLoader<Uuid, number>;
  actorByIdLoader?: DataLoader<Uuid, Actor | null>;
  // Request-scoped visibility of PostLink nodes: a link is hidden when
  // every post referencing it is censored for the viewer.  Batched so
  // link-heavy pages (the news list) stay free of per-link lookups.
  postLinkVisibleLoader?: DataLoader<Uuid, boolean>;
  // Request-scoped cache so that viewerCanReply, viewerCanQuote, and
  // viewerCanShare for the same post and selected viewer actor only run
  // one relational lookup even though they are exposed as three separate
  // loadable fields.
  // Pending promises are stored synchronously so concurrent dispatch from
  // the three loaders doesn't each fire its own duplicate query.
  viewerActionPoliciesCache?: Map<string, Promise<PostInteractionPolicy>>;
  organizationInvitationNotificationsEnsured?: {
    db: Database;
    promises: Map<Uuid, Promise<void>>;
  };
}

export interface PothosTypes {
  DefaultFieldNullability: false;
  DrizzleRelations: typeof relations;
  Context: UserContext;
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
    Sha256: {
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
    DataloaderPlugin,
    SimpleObjectsPlugin,
    TracingPlugin,
    WithInputPlugin,
    ErrorsPlugin,
  ],
  complexity: {
    defaultComplexity: 1,
    defaultListMultiplier: 10,
    limit: (ctx) => ({
      complexity: ctx.session == null ? 20000 : 25000,
      depth: ctx.session == null ? 11 : 20,
      breadth: 2500,
    }),
    complexityError: (errorKind, result, _info) => {
      // https://pothos-graphql.dev/docs/plugins/complexity#options
      // FIXME: Not sure but we cannot use LogTape here.

      const value =
        result[errorKind.toLowerCase() as Lowercase<typeof errorKind>];
      const maxValue = result[`max${errorKind}`];
      const errorMessage =
        `Query exceeds ${errorKind} limit (${value} > ${maxValue})`;
      console.error(errorMessage);
      throw createGraphQLError(errorMessage);
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
  errors: {
    directResult: true,
    defaultUnionOptions: {
      name(options) {
        return `${options.fieldName.charAt(0).toUpperCase()}${
          options.fieldName.slice(1)
        }Result`;
      },
    },
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

const sha256Pattern = /^[0-9a-f]{64}$/;

function normalizeSha256(value: unknown): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw createGraphQLError(
      "Expected a lowercase hex-encoded SHA-256 digest.",
    );
  }
  return value;
}

builder.addScalarType(
  "Sha256",
  new GraphQLScalarType<string, string>({
    name: "Sha256",
    description: "A lowercase hex-encoded SHA-256 digest.",
    serialize: normalizeSha256,
    parseValue: normalizeSha256,
    parseLiteral(ast) {
      if (ast.kind !== Kind.STRING) {
        throw createGraphQLError(
          `Can only validate strings as SHA-256 digests but got a: ${ast.kind}`,
          { nodes: ast },
        );
      }
      return normalizeSha256(ast.value);
    },
    extensions: {
      codegenScalarType: "string",
      jsonSchema: {
        type: "string",
        pattern: "^[0-9a-f]{64}$",
      },
    },
  }),
);

builder.queryType({});
builder.mutationType({});

export const Node = builder.nodeInterfaceRef();
