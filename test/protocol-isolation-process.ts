/** Test-only processes: real transport/admission/schema, controlled Fedify dispatchers. */
import {
  createFederationBuilder,
  type KvKey,
  type KvStore,
  type MessageQueue,
} from "@fedify/fedify";
import { Endpoints, Follow, Note, Person } from "@fedify/vocab";
import {
  defineApplicationModel,
  type ContextData,
} from "@hackerspub/models/context";
import { createSession } from "@hackerspub/models/session";
import type { Uuid } from "@hackerspub/models/uuid";
import {
  createDatabaseResources,
  type RuntimeResources,
} from "@hackerspub/runtime/resources";
import Keyv from "keyv";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers/promises";
import { createGraphqlApiHandler } from "../graphql/api.ts";
import { createNodeHttpServer } from "../graphql/node-http.ts";
import { ProtocolAdmission } from "../graphql/protocol-admission.ts";
import {
  createProtocolKvStore,
  createProtocolLoaders,
} from "../runtime/protocol-loaders.ts";
import { getSqlWorkStats } from "../runtime/sql-work.ts";

// Resolve through the package that declares the adapter. This uses its public
// export and the same installed version as production, without a root dependency.
const adapter = createRequire(
  new URL("../runtime/package.json", import.meta.url),
)("@fedify/postgres") as {
  PostgresKvStore: new (
    sql: ReturnType<typeof createDatabaseResources>["postgres"],
    options: { tableName: string; initialized?: boolean },
  ) => KvStore & { initialize(): Promise<void>; drop(): Promise<void> };
  PostgresMessageQueue: new (
    sql: ReturnType<typeof createDatabaseResources>["postgres"],
    options: {
      tableName: string;
      channelName: string;
      initialized?: boolean;
      pollInterval: { milliseconds: number };
    },
  ) => MessageQueue & { initialize(): Promise<void>; drop(): Promise<void> };
};

export const fixtureProtocolConfig = {
  limit: 2,
  deadlineMs: 350,
  bodyLimitBytes: 1024 * 1024,
  responseLimitBytes: 1024 * 1024,
  sqlLimit: 32,
  sqlTimeoutMs: 1500,
  loaderLimit: 8,
  loaderTimeoutMs: 200,
};

export interface FixtureConfig {
  role: "interactive" | "protocol" | "worker";
  runId: string;
  accountId: Uuid;
  sessionId: Uuid;
  signerUrl: string;
  signerDocument: unknown;
}

export interface FixtureStats {
  pid: number;
  http: {
    active: number;
    admitted: number;
    completed: number;
    rejected: number;
    stopping: boolean;
  };
  sql: { active: number; limit: number; nativeCancellations: number } | null;
  loaders: { active: number; limit: number } | null;
  peaks: { http: number; sql: number; loaders: number };
  consumed: string[];
  dispatches: Record<string, number>;
}

async function main(config: FixtureConfig): Promise<void> {
  const protocol = config.role === "protocol";
  const { db, postgres: sql } = createDatabaseResources({
    url: process.env.DATABASE_URL!,
    maxConnections: 2,
    applicationName: `hp-isolation-${config.runId}-${config.role}`,
    ...(protocol ? { protocolWork: { limit: 32, timeoutMs: 1500 } } : {}),
  });
  const rawKv = new adapter.PostgresKvStore(sql, {
    tableName: `hp_iso_kv_${config.runId}`,
    initialized: config.role !== "protocol",
  });
  const queue = new adapter.PostgresMessageQueue(sql, {
    tableName: `hp_iso_queue_${config.runId}`,
    channelName: `hp_iso_channel_${config.runId}`,
    initialized: config.role !== "protocol",
    pollInterval: { milliseconds: 50 },
  });
  if (config.role !== "interactive") {
    await rawKv.initialize();
    await queue.initialize();
  }
  const controlledKv: KvStore = new Proxy(rawKv, {
    get(target, property) {
      if (property === "get")
        return async (key: KvKey) => {
          if (
            key[0] === "_fedify" &&
            key[1] === "remoteDocument" &&
            key[2] === "https://loader.isolation.example/slow"
          ) {
            // Deliberately ignores the caller's signal, proving ownership after
            // the local loader timeout and HTTP deadline have already fired.
            await setTimeout(1000);
            return {
              contextUrl: null,
              documentUrl: key[2],
              document: {
                "@context": "https://www.w3.org/ns/activitystreams",
                type: "Note",
                content: "cached",
              },
            };
          }
          return target.get(key);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const federationKv = protocol ? createProtocolKvStore(controlledKv) : rawKv;
  const loaders = protocol
    ? createProtocolLoaders({
        kv: federationKv,
        limit: 8,
        timeoutMs: 200,
        userAgent: { software: "HackersPub/protocol-isolation-test" },
      })
    : undefined;
  if (protocol) {
    for (const url of [config.signerUrl, `${config.signerUrl}#main-key`]) {
      await federationKv.set(["_fedify", "remoteDocument", url], {
        contextUrl: null,
        documentUrl: config.signerUrl,
        document: config.signerDocument,
      });
    }
  }
  const consumed: string[] = [];
  const dispatches: Record<string, number> = {};
  const admission = new ProtocolAdmission(fixtureProtocolConfig);
  const peaks = { http: 0, sql: 0, loaders: 0 };
  function snapshot(): FixtureStats {
    const sqlStats = getSqlWorkStats(sql);
    const loaderStats = loaders?.stats();
    peaks.http = Math.max(peaks.http, admission.stats.active);
    peaks.sql = Math.max(peaks.sql, sqlStats?.active ?? 0);
    peaks.loaders = Math.max(peaks.loaders, loaderStats?.active ?? 0);
    return {
      pid: process.pid,
      http: admission.stats,
      sql: sqlStats ?? null,
      loaders: loaderStats ?? null,
      peaks: { ...peaks },
      consumed: [...consumed],
      dispatches: { ...dispatches },
    };
  }
  const builder = createFederationBuilder<ContextData>();
  builder.setActorDispatcher(
    "/ap/actors/{identifier}",
    (ctx, identifier) =>
      new Person({
        id: ctx.getActorUri(identifier),
        preferredUsername: identifier,
        inbox: ctx.getInboxUri(identifier),
        endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
      }),
  );
  builder.setObjectDispatcher(Note, "/ap/objects/{id}", async (ctx, { id }) => {
    dispatches[id] = (dispatches[id] ?? 0) + 1;
    snapshot();
    if (id === "sql") {
      await sql`select pg_sleep(1)`;
    } else if (id === "loader") {
      await ctx.documentLoader("https://loader.isolation.example/slow");
    } else if (id === "cpu") {
      process.send?.({ kind: "cpu-start" });
      const until = performance.now() + 600;
      while (performance.now() < until) Math.sqrt(performance.now());
    } else {
      await sql`select 1`;
    }
    return new Note({
      id: ctx.getObjectUri(Note, { id }),
      attribution: ctx.getActorUri("fixture"),
      content: `Valid fixture note ${id}`,
    });
  });
  builder
    .setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox")
    .on(Follow, async (_ctx, activity) => {
      consumed.push(activity.id!.href);
      process.send?.({ kind: "consumed", activityId: activity.id!.href });
    });
  const federation = await builder.build({
    kv: federationKv,
    ...(config.role === "interactive" ? {} : { queue: { inbox: queue } }),
    manuallyStartQueue: true,
    ...loaders?.options,
  });
  const kv = new Keyv();
  if (config.role === "interactive")
    await createSession(kv, {
      id: config.sessionId,
      accountId: config.accountId,
      authenticationMethod: "passkey",
    });
  const unavailable = defineApplicationModel(undefined, "unavailable");
  const disk = {
    getUrl: async (key: string) => `http://localhost/media/${key}`,
  };
  const resources = {
    config: { behindProxy: false, email: { from: "fixture@example.com" } },
    db,
    postgres: sql,
    kv,
    federation,
    drive: { use: () => disk },
    models: {
      summarizer: unavailable,
      translator: unavailable,
      moderationAnalyzer: unavailable,
    },
  } as unknown as RuntimeResources;
  const shutdown = new AbortController();
  let queueWork: Promise<void> | undefined;
  let http: ReturnType<typeof createNodeHttpServer> | undefined;
  let yoga:
    | ReturnType<(typeof import("../graphql/mod.ts"))["createYogaServer"]>
    | undefined;
  let port: number | undefined;
  const ticker = setInterval(snapshot, 5);
  ticker.unref();
  if (config.role === "worker") {
    queueWork = federation.startQueue(
      { db, kv, disk, models: resources.models } as unknown as ContextData,
      { signal: shutdown.signal },
    );
    void queueWork.catch((error) => {
      if (!shutdown.signal.aborted)
        process.send?.({ kind: "fatal", message: String(error) });
    });
  } else {
    if (config.role === "interactive") {
      const { createYogaServer } = await import("../graphql/mod.ts");
      yoga = createYogaServer();
    }
    http = createNodeHttpServer(
      createGraphqlApiHandler({
        resources,
        yogaServer: yoga,
        role: config.role,
        ...(protocol ? { protocolAdmission: admission } : {}),
        assetlinksJson: "[]",
        appleAppSiteAssociationJson: "{}",
      }),
      { drainTimeout: 2500 },
    );
    port = (await http.listen({ hostname: "127.0.0.1", port: 0 })).port;
  }
  process.send?.({ kind: "ready", pid: process.pid, port });
  let closing = false;
  process.on("message", (message: { kind: string; id?: number }) => {
    if (message.kind === "stats")
      process.send?.({ kind: "stats", id: message.id, value: snapshot() });
    else if (message.kind === "stop-admission") {
      admission.stop();
      process.send?.({ kind: "stopped", id: message.id });
    } else if (message.kind === "shutdown" && !closing) {
      closing = true;
      void (async () => {
        admission.stop();
        shutdown.abort();
        await http?.close();
        admission.abort();
        await admission.idle();
        await queueWork;
        await yoga?.dispose();
        clearInterval(ticker);
        await kv.disconnect();
        await sql.end();
        process.disconnect();
      })().catch((error) => {
        process.send?.({ kind: "fatal", message: String(error) });
        process.exitCode = 1;
        process.disconnect();
      });
    }
  });
}

if (process.argv[2] === "child") {
  await main(
    JSON.parse(process.env.PROTOCOL_ISOLATION_FIXTURE!) as FixtureConfig,
  );
}
