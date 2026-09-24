import { toApplicationContext } from "@hackerspub/federation/context";
import {
  lockArticleSource,
  syncArticleContentVariants,
} from "@hackerspub/models/article-publication";
import { withTransaction } from "@hackerspub/models/tx";
import type { Uuid } from "@hackerspub/models/uuid";
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

const BATCH_SIZE = 100;

/**
 * Materializes `post_content_variant` rows for every local article published
 * before variants existed.
 *
 * Idempotent: each article is rebuilt from its current `article_content` rows
 * under its source lock, exactly as a publication would, so it is safe to run
 * again or while the application is serving traffic. It federates nothing.
 * Remote posts are not touched: their language alternatives were never stored,
 * and are recovered only when the post is fetched again.
 */
export async function main(): Promise<void> {
  const config = loadGraphqlApiConfig(getProcessEnvironment(), {
    allowFileKv: true,
  });
  const resources = await createRuntimeResources(config, metadata.version, {
    fileSystemBaseUrl: FILE_SYSTEM_STORAGE_BASE_URL,
    federation: {
      manuallyStartQueue: true,
      firstKnock: "draft-cavage-http-signatures-12",
    },
  });
  let synced = 0;
  let failures = 0;
  try {
    const fedCtx = toApplicationContext(
      resources.federation.createContext(config.origin, {
        db: resources.db,
        kv: resources.kv,
        disk: resources.drive.use(),
        models: resources.models,
        services,
      }),
    );
    let after: Uuid | undefined;
    while (true) {
      // The query builder keeps this script free of a direct drizzle-orm
      // import: the root package only has it as a dev dependency, and
      // production images install without dev dependencies.
      const batch = await resources.db.query.articleSourceTable.findMany({
        columns: { id: true },
        where: after == null ? undefined : { id: { gt: after } },
        orderBy: { id: "asc" },
        limit: BATCH_SIZE,
      });
      if (batch.length < 1) break;
      for (const { id } of batch) {
        try {
          await withTransaction(fedCtx, async (context) => {
            if (!(await lockArticleSource(context.db, id))) return;
            await syncArticleContentVariants(context, id);
          });
          synced++;
        } catch (error) {
          failures++;
          console.error(`Failed ${id}:`, error);
        }
      }
      after = batch[batch.length - 1].id;
      console.log(`${synced} article(s) synced so far.`);
    }
    console.log(`${synced} synced, ${failures} failed.`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await resources.close();
  }
}

if (isMain(import.meta)) await main();
