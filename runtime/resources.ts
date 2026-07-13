import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type { Federation, FederationOptions } from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import { RedisKvStore } from "@fedify/redis";
import {
  type ContextData,
  defineApplicationModel,
  type Models,
} from "@hackerspub/models/context";
import type { Database } from "@hackerspub/models/db";
import { relations } from "@hackerspub/models/relations";
import { getLogger as getDatabaseLogger } from "@logtape/drizzle-orm";
import { getLogger } from "@logtape/logtape";
import type { Transport } from "@upyo/core";
import { MailgunTransport } from "@upyo/mailgun";
import { MockTransport } from "@upyo/mock";
import KeyvRedis from "@keyv/redis";
import { drizzle } from "drizzle-orm/postgres-js";
import { type Disk, DriveManager } from "flydrive";
import { FSDriver } from "flydrive/drivers/fs";
import { S3Driver } from "flydrive/drivers/s3";
import { Redis } from "ioredis";
import Keyv from "keyv";
import { KeyvFile } from "keyv-file";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgresJs, { type Sql } from "postgres";
import type { KeyValueConfig, ServerConfig } from "./config.ts";

export interface DatabaseResources {
  readonly postgres: Sql;
  readonly db: Database;
}

export function createDatabaseResources(
  config: ServerConfig["database"],
): DatabaseResources {
  const postgres = postgresJs(config.url, { max: 20 });
  const db: Database = drizzle({
    relations,
    client: postgres,
    logger: getDatabaseLogger(),
  });
  getLogger(["hackerspub", "db"]).debug("The driver is ready: {driver}", {
    driver: db.constructor,
  });
  return { postgres, db };
}

export function createKeyValueResource(config: KeyValueConfig): Keyv {
  const adapter = config.url.protocol === "file:"
    ? new KeyvFile({ filename: fileURLToPath(config.url) })
    : new KeyvRedis(config.url.href);
  return new Keyv(adapter);
}

export interface DriveResource {
  readonly fileSystemRoot?: URL;
  use(): Disk;
}

export function resolveFileSystemStorageLocation(
  location: string,
  baseUrl: URL,
): URL {
  return pathToFileURL(resolve(fileURLToPath(baseUrl), location));
}

export function createDriveResource(
  config: ServerConfig["storage"],
  origin: URL,
  fileSystemBaseUrl: URL,
): DriveResource {
  if (config.driver === "fs") {
    const fileSystemRoot = resolveFileSystemStorageLocation(
      config.location,
      fileSystemBaseUrl,
    );
    const drive = new DriveManager({
      default: "fs",
      services: {
        fs: () =>
          new FSDriver({
            location: fileSystemRoot,
            visibility: "public",
            urlBuilder: {
              generateURL: (key) =>
                Promise.resolve(new URL(`/media/${key}`, origin).href),
              generateSignedURL: (key) =>
                Promise.resolve(new URL(`/media/${key}`, origin).href),
            },
          }),
      },
    });
    return Object.assign(drive, { fileSystemRoot });
  }
  return new DriveManager({
    default: "s3",
    services: {
      s3: () =>
        new S3Driver({
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
          endpoint: config.endpoint,
          cdnUrl: config.cdnUrl,
          region: config.region,
          bucket: config.bucket,
          visibility: "public",
        }),
    },
  });
}

export interface FederationResourceOptions {
  readonly manuallyStartQueue: boolean;
  readonly firstKnock?: NonNullable<
    FederationOptions<ContextData>["firstKnock"]
  >;
}

export function getFederationBehaviorOptions(
  options: FederationResourceOptions,
): Pick<
  FederationOptions<ContextData>,
  "firstKnock" | "manuallyStartQueue"
> {
  return {
    manuallyStartQueue: options.manuallyStartQueue,
    ...(options.firstKnock == null ? {} : { firstKnock: options.firstKnock }),
  };
}

interface FederationQueueRunner<TContextData> {
  startQueue(
    contextData: TContextData,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

type LifecycleCompletion =
  | { readonly source: "queue" | "server"; readonly successful: true }
  | {
    readonly source: "queue" | "server";
    readonly successful: false;
    readonly error: unknown;
  };

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export async function runWithFederationQueue<TContextData>(
  federation: FederationQueueRunner<TContextData>,
  contextData: TContextData,
  runServer: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const settle = (
    source: "queue" | "server",
    promise: Promise<void>,
  ): Promise<LifecycleCompletion> =>
    promise.then(
      () => ({ source, successful: true }),
      (error: unknown) => ({ source, successful: false, error }),
    );
  const queueCompletion = settle(
    "queue",
    federation.startQueue(contextData, { signal: controller.signal }),
  );
  const serverCompletion = settle(
    "server",
    Promise.resolve().then(() => runServer(controller.signal)),
  );

  const first = await Promise.race([queueCompletion, serverCompletion]);
  controller.abort();
  const [queue, server] = await Promise.all([
    queueCompletion,
    serverCompletion,
  ]);

  if (!first.successful) throw first.error;
  if (first.source === "queue") {
    throw new Error("The federation queue stopped before the server.");
  }
  if (!server.successful) throw server.error;
  if (!queue.successful && !isAbortError(queue.error)) throw queue.error;
}

export interface WarningLogger {
  warning(message: string): void;
}

export function createEmailResource(
  config: ServerConfig["email"],
  logger: WarningLogger = getLogger(["hackerspub", "email"]),
): Transport {
  if (config.transport === "mock") {
    if (config.reason === "mailgun-unconfigured") {
      logger.warning(
        "MAILGUN_* environment variables are not configured; using MockTransport. Emails will not be delivered.",
      );
    }
    return new MockTransport();
  }
  return new MailgunTransport({
    apiKey: config.apiKey,
    domain: config.domain,
    region: config.region,
  });
}

export function createAiModels(config: ServerConfig["ai"]): Models & {
  altTextGenerator: ReturnType<typeof google>;
} {
  return {
    altTextGenerator: google(config.altTextModel),
    summarizer: defineApplicationModel(google(config.summarizerModel)),
    translator: defineApplicationModel(anthropic(config.translatorModel)),
    moderationAnalyzer: defineApplicationModel(
      anthropic(config.moderationModel),
    ),
  };
}

export async function createFederationResource(
  config: Pick<ServerConfig, "origin" | "kv">,
  postgres: Sql,
  softwareVersion: string,
  options: FederationResourceOptions,
): Promise<{
  readonly federation: Federation<ContextData>;
  close(): Promise<void>;
}> {
  const { builder } = await import("@hackerspub/federation");
  const redis = config.kv.url.protocol === "redis:"
    ? new Redis(config.kv.url.href, {
      family: config.kv.url.hostname.endsWith(".upstash.io") ? 6 : 4,
    })
    : undefined;
  const federationKv = redis == null
    ? new PostgresKvStore(postgres)
    : new RedisKvStore(redis);
  const queue = new PostgresMessageQueue(postgres, {
    handlerTimeout: { seconds: 180 },
  });
  let federation: Federation<ContextData>;
  try {
    federation = await builder.build({
      kv: federationKv,
      queue,
      ...getFederationBehaviorOptions(options),
      origin: config.origin.href,
      userAgent: {
        software: `HackersPub/${softwareVersion}`,
        url: config.origin,
      },
    });
  } catch (error) {
    if (redis != null) await redis.quit();
    throw error;
  }
  return {
    federation,
    async close() {
      if (redis != null) await redis.quit();
    },
  };
}

export interface RuntimeResources {
  readonly config: ServerConfig;
  readonly postgres: Sql;
  readonly db: Database;
  readonly kv: Keyv;
  readonly drive: ReturnType<typeof createDriveResource>;
  readonly email: Transport;
  readonly models: ReturnType<typeof createAiModels>;
  readonly federation: Awaited<
    ReturnType<typeof createFederationResource>
  >["federation"];
  close(): Promise<void>;
}

export interface RuntimeResourceOptions {
  readonly fileSystemBaseUrl: URL;
  readonly federation: FederationResourceOptions;
}

type ResourceCleanup = () => Promise<unknown>;

async function closeResourceHandles(
  cleanups: readonly ResourceCleanup[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Failed to close runtime resources.");
  }
}

export async function createRuntimeResources(
  config: ServerConfig,
  softwareVersion: string,
  options: RuntimeResourceOptions,
): Promise<RuntimeResources> {
  const { postgres, db } = createDatabaseResources(config.database);
  const cleanups: ResourceCleanup[] = [() => postgres.end()];
  try {
    const kv = createKeyValueResource(config.kv);
    cleanups.unshift(() => kv.disconnect());
    const drive = createDriveResource(
      config.storage,
      config.origin,
      options.fileSystemBaseUrl,
    );
    const email = createEmailResource(config.email);
    const models = createAiModels(config.ai);
    const federationResources = await createFederationResource(
      config,
      postgres,
      softwareVersion,
      options.federation,
    );
    cleanups.unshift(() => federationResources.close());
    const { federation } = federationResources;
    return {
      config,
      postgres,
      db,
      kv,
      drive,
      email,
      models,
      federation,
      async close() {
        await closeResourceHandles(cleanups);
      },
    };
  } catch (error) {
    try {
      await closeResourceHandles(cleanups);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Failed to create and clean up runtime resources.",
      );
    }
    throw error;
  }
}
