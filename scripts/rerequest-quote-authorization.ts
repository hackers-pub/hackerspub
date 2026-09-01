import { toApplicationContext } from "@hackerspub/federation/context";
import {
  findQuoteAuthorizationRerequestPostIds,
  rerequestQuoteAuthorization,
  type QuoteAuthorizationRerequestResult,
} from "@hackerspub/models/post/quote-rerequest";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import {
  getProcessEnvironment,
  loadGraphqlApiConfig,
} from "@hackerspub/runtime/config";
import {
  createRuntimeResources,
  FILE_SYSTEM_STORAGE_BASE_URL,
} from "@hackerspub/runtime/resources";
import process from "node:process";
import metadata from "../graphql/package.json" with { type: "json" };
import { services } from "../graphql/services.ts";
import { isMain } from "../runtime/main.ts";

export interface RerequestQuoteAuthorizationOptions {
  readonly dryRun: boolean;
  readonly uuid?: Uuid;
}

export function parseRerequestQuoteAuthorizationArgs(
  args: readonly string[],
): RerequestQuoteAuthorizationOptions {
  let dryRun = false;
  let uuid: Uuid | undefined;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    if (uuid != null) throw new Error("Expected at most one post UUID.");
    if (!validateUuid(arg)) throw new Error(`Invalid UUID: ${arg}`);
    uuid = arg;
  }
  return { dryRun, ...(uuid == null ? {} : { uuid }) };
}

function describeResult(result: QuoteAuthorizationRerequestResult): string {
  const prefix = `${result.postId} (${result.postIri})`;
  if (result.status === "skipped") {
    return `Skipped ${prefix}: ${result.reason}.`;
  }
  if (result.status === "eligible") {
    return `Would refresh and request ${prefix} -> ${result.quotedPostIri}.`;
  }
  return `Refreshed and requested ${prefix} -> ${result.quotedPostIri} as ${result.requestIri}.`;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let options: RerequestQuoteAuthorizationOptions;
  try {
    options = parseRerequestQuoteAuthorizationArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(
      "Usage: mise run rerequest-quote-authorization -- [--dry-run] [POST_UUID]",
    );
    process.exitCode = 1;
    return;
  }

  const config = loadGraphqlApiConfig(getProcessEnvironment(), {
    // A dry run never enqueues delivery, so local API-only development may
    // inspect candidates without provisioning Redis.
    allowFileKv: options.dryRun,
  });
  const resources = await createRuntimeResources(config, metadata.version, {
    fileSystemBaseUrl: FILE_SYSTEM_STORAGE_BASE_URL,
    federation: {
      manuallyStartQueue: true,
      // Keep this aligned with the API and federation worker.
      firstKnock: "draft-cavage-http-signatures-12",
    },
  });
  let failures = 0;
  let requested = 0;
  let eligible = 0;
  let skipped = 0;
  try {
    const contextData = {
      db: resources.db,
      kv: resources.kv,
      disk: resources.drive.use(),
      models: resources.models,
      services,
    };
    const fedCtx = toApplicationContext(
      resources.federation.createContext(config.origin, contextData),
    );
    const postIds = await findQuoteAuthorizationRerequestPostIds(
      resources.db,
      options.uuid,
    );
    if (options.uuid != null && postIds.length < 1) {
      console.error(`No post found for UUID ${options.uuid}.`);
      process.exitCode = 1;
      return;
    }
    for (const postId of postIds) {
      try {
        const result = await rerequestQuoteAuthorization(fedCtx, postId, {
          dryRun: options.dryRun,
        });
        console.log(describeResult(result));
        if (result.status === "requested") requested++;
        else if (result.status === "eligible") eligible++;
        else skipped++;
      } catch (error) {
        failures++;
        console.error(`Failed ${postId}:`, error);
      }
    }
    console.log(
      options.dryRun
        ? `Dry run: ${eligible} eligible, ${skipped} skipped, ${failures} failed.`
        : `${requested} requested, ${skipped} skipped, ${failures} failed.`,
    );
    if (failures > 0) process.exitCode = 1;
  } finally {
    await resources.close();
  }
}

if (isMain(import.meta)) await main();
