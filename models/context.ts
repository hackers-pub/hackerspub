import type * as vocab from "@fedify/vocab";
import type { DocumentLoader } from "@fedify/vocab-runtime";
import type { Disk } from "flydrive";
import type Keyv from "keyv";
import type { Database } from "./db.ts";
import type { ApplicationServices } from "./services.ts";

export type AfterCommitTask = () => Promise<void> | void;

export interface KeyValueStore {
  get<Value>(key: string): Promise<Value | undefined>;
  getMany<Value>(keys: string[]): Promise<Array<Value | undefined>>;
  set<Value>(key: string, value: Value, ttl?: number): Promise<boolean>;
}

export interface StorageService {
  put(
    key: string,
    contents: string | Uint8Array,
    options?: { readonly contentType?: string; readonly visibility?: string },
  ): Promise<void>;
  getUrl(key: string): Promise<string>;
  getBytes(key: string): Promise<Uint8Array>;
}

/** Opaque AI model handle interpreted only by the configured AI adapter. */
export interface ApplicationModel {
  readonly id: string;
  readonly implementation: unknown;
}

export function defineApplicationModel(
  implementation: unknown,
  id = typeof implementation === "string"
    ? implementation
    : ((implementation as { modelId?: string })?.modelId ?? "unknown"),
): ApplicationModel {
  return { id, implementation };
}

export interface Models {
  translator: ApplicationModel;
  summarizer: ApplicationModel;
  /**
   * Matches reports against the code of conduct (a reference tool for
   * moderators, never an automated decision system).
   */
  moderationAnalyzer: ApplicationModel;
}

export interface ContextData<D extends Database = Database> {
  db: D;
  rootDb?: Database;
  afterCommit?: AfterCommitTask[];
  kv: Keyv;
  disk: Disk;
  models: Models;
  services: ApplicationServices<ApplicationContext>;
}

/**
 * Runtime-neutral dependencies used by application operations.
 *
 * Fedify adapters translate their request context into this plain object;
 * transaction helpers can therefore replace the database handle without
 * manufacturing a new HTTP or federation request context.
 */
export interface ApplicationContext<D extends Database = Database> {
  db: D;
  /** Rebind every adapter capability to a different database handle. */
  withDatabase(db: Database): ApplicationContext;
  rootDb?: Database;
  afterCommit?: AfterCommitTask[];
  kv: KeyValueStore;
  storage: StorageService;
  models: Models;
  services: ApplicationServices<ApplicationContext>;
  /** Request-scoped federation capability supplied by an adapter. */
  federation: object;
  readonly origin: string;
  readonly canonicalOrigin: string;
  readonly host: string;
  readonly documentLoader: DocumentLoader;
  readonly contextLoader: DocumentLoader;
  getActorUri(identifier: string): URL;
  getInboxUri(identifier?: string): URL;
  getOutboxUri(identifier: string): URL;
  getFollowersUri(identifier: string): URL;
  getFollowingUri(identifier: string): URL;
  getFeaturedUri(identifier: string): URL;
  getObjectUri(type: unknown, values: Record<string, string>): URL;
  getDocumentLoader(options?: unknown): DocumentLoader;
  lookupObject(
    value: string | URL,
    options?: object,
  ): Promise<vocab.Object | null>;
  lookupWebFinger(resource: string | URL): Promise<{
    links?: readonly {
      rel: string;
      type?: string;
      href?: string;
      template?: string;
    }[];
  } | null>;
  getActor(identifier: string): Promise<vocab.Actor | null>;
  getActorKeyPairs?(identifier: string): Promise<unknown>;
  sendActivity(
    sender: unknown,
    recipients: unknown,
    activity: vocab.Activity,
    options?: unknown,
  ): Promise<void>;
}
