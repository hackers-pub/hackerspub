import { repairBrokenLinkPreviews } from "@hackerspub/models/link-preview";
import {
  getDenoEnvironment,
  loadDatabaseConfig,
} from "@hackerspub/runtime/config";
import { createDatabaseResources } from "@hackerspub/runtime/resources";

const database = loadDatabaseConfig(getDenoEnvironment());
const { db, postgres } = createDatabaseResources(database);

try {
  const result = await db.transaction((tx) => repairBrokenLinkPreviews(tx));
  console.log(
    `Repaired ${result.repairedPosts} post(s) from ` +
      `${result.brokenLinks} broken link(s); ` +
      `${result.unresolvedPosts} post(s) require manual review.`,
  );
} finally {
  await postgres.end();
}
