import { page } from "@fresh/core";
import { accountTable, actorTable, postTable } from "@hackerspub/models/schema";
import { validateUuid } from "@hackerspub/models/uuid";
import { and, count, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { AdminNav } from "../../components/AdminNav.tsx";
import { Button } from "../../components/Button.tsx";
import { db } from "../../db.ts";
import { kv } from "../../kv.ts";
import { define } from "../../utils.ts";

// Key used to store the last invitation regeneration timestamp in KV
const LAST_REGEN_KEY = "invitations_last_regen";

export const handler = define.handlers({
  async GET(_ctx) {
    // Get the last regeneration timestamp from KV
    const lastRegenTimestamp = await kv.get<string>(LAST_REGEN_KEY);
    let lastRegenDate: Date | null = null;

    if (lastRegenTimestamp) {
      lastRegenDate = new Date(lastRegenTimestamp);
    }

    return page<RegenerateInvitationsProps>({ lastRegenDate });
  },

  async POST(_ctx) {
    // Determine the cutoff date for post activity
    const lastRegenTimestamp = await kv.get<string>(LAST_REGEN_KEY);
    let cutoffDate: Date;

    if (lastRegenTimestamp) {
      cutoffDate = new Date(lastRegenTimestamp);
    } else {
      // Default to one week ago if no previous regeneration
      cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 7);
    }

    // Get post counts per actor since the cutoff date
    const accountPostCounts = await db
      .select({
        accountId: actorTable.accountId,
        postCount: count(),
      })
      .from(postTable)
      .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
      .where(
        and(
          isNotNull(actorTable.accountId),
          gt(postTable.published, cutoffDate),
        ),
      )
      .groupBy(actorTable.accountId)
      .orderBy(desc(count()));

    // Calculate the top third
    const activeAccounts = accountPostCounts.length;
    const topThirdCount = Math.ceil(activeAccounts / 3);
    const topAccountIds = accountPostCounts
      .slice(0, topThirdCount)
      .map((a) => a.accountId)
      .filter(validateUuid);

    // Update the left_invitations for the top accounts
    if (topAccountIds.length > 0) {
      for (const accountId of topAccountIds) {
        await db
          .update(accountTable)
          .set({
            leftInvitations: sql`${accountTable.leftInvitations} + 1`,
          })
          .where(eq(accountTable.id, accountId));
      }
    }

    // Store the current timestamp as the last regeneration time
    const now = new Date();
    await kv.set(LAST_REGEN_KEY, now.toISOString());

    // Return the same page with updated timestamp
    return page<RegenerateInvitationsProps>({
      lastRegenDate: now,
      regenerated: true,
      accountsCount: topAccountIds.length,
    });
  },
});

interface RegenerateInvitationsProps {
  lastRegenDate: Date | null;
  regenerated?: boolean;
  accountsCount?: number;
}

export default define.page<typeof handler, RegenerateInvitationsProps>(
  function RegenerateInvitations({ state: { language }, data }) {
    const { lastRegenDate, regenerated, accountsCount } = data;

    return (
      <div>
        <AdminNav active="invitations" />

        <div class="mb-6">
          <p class="mb-4">
            This will regenerate invitations for the most active users (top 1/3
            by post count) since {lastRegenDate
              ? `the last regeneration (${
                lastRegenDate.toLocaleString(language)
              })`
              : "the last week"}.
          </p>

          {regenerated && (
            <div class="bg-green-100 dark:bg-green-900 p-4 rounded mb-4">
              <p>
                Successfully regenerated invitations for {accountsCount}{" "}
                accounts.
              </p>
            </div>
          )}

          <form method="POST">
            <Button type="submit">Regenerate Invitations</Button>
          </form>
        </div>
      </div>
    );
  },
);
