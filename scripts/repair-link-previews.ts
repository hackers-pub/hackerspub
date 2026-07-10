import { repairBrokenLinkPreviews } from "@hackerspub/models/link-preview";
import { db, postgres } from "../graphql/db.ts";

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
