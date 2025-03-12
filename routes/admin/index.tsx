import { count, desc, eq, isNotNull, max } from "drizzle-orm";
import { page } from "fresh";
import { AdminNav } from "../../components/AdminNav.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import { Timestamp } from "../../islands/Timestamp.tsx";
import { getAvatarUrl } from "../../models/account.ts";
import {
  type Account,
  type AccountEmail,
  accountTable,
  type Actor,
  actorTable,
  postTable,
} from "../../models/schema.ts";
import type { Uuid } from "../../models/uuid.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(_ctx) {
    const accounts = await db.query.accountTable.findMany({
      with: { emails: true, actor: true },
      orderBy: desc(accountTable.created),
    });
    const postsMetadata: Record<
      Uuid,
      { count: number; lastPublished: Date | null }
    > = Object.fromEntries(
      (await db.select({
        accountId: actorTable.accountId,
        count: count(),
        lastPublished: max(postTable.published),
      })
        .from(postTable)
        .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
        .where(isNotNull(actorTable.accountId))
        .groupBy(actorTable.accountId)).map((
          { accountId, count, lastPublished },
        ) => [accountId, { count, lastPublished }]),
    );
    // Sort accounts by the latest post published date
    accounts.sort((a, b) => {
      const aLastPublished = postsMetadata[a.id]?.lastPublished;
      const bLastPublished = postsMetadata[b.id]?.lastPublished;
      if (aLastPublished == null) return 1;
      if (bLastPublished == null) return -1;
      return bLastPublished.getTime() - aLastPublished.getTime();
    });
    const avatars = Object.fromEntries(
      await Promise.all(
        accounts.map(async (
          account,
        ) => [account.id, await getAvatarUrl(account)]),
      ),
    );
    return page<AccountListProps>({ accounts, postsMetadata, avatars });
  },
});

interface AccountListProps {
  accounts: (Account & { actor: Actor; emails: AccountEmail[] })[];
  postsMetadata: Record<Uuid, { count: number; lastPublished: Date | null }>;
  avatars: Record<Uuid, string>;
}

export default define.page<typeof handler, AccountListProps>(
  function AccountList(
    { state: { language }, data: { accounts, postsMetadata, avatars } },
  ) {
    return (
      <div>
        <AdminNav active="accounts" />
        <PageTitle>Accounts</PageTitle>
        <table class="table table-auto border-collapse border border-stone-300 dark:border-stone-500 w-full">
          <thead>
            <tr>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                ID
              </th>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                Avatar
              </th>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                Username
              </th>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                Name
              </th>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                Following
              </th>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                Followers
              </th>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                Posts
              </th>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr>
                <th class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                  {account.id}
                </th>
                <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 w-[64px]">
                  <a href={`/@${account.username}`}>
                    <img
                      src={avatars[account.id]}
                      width={64}
                      height={64}
                      alt={account.name}
                    />
                  </a>
                </td>
                <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                  <a href={`/@${account.username}`}>{account.username}</a>
                </td>
                <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                  <a href={`/@${account.username}`}>{account.name}</a>
                </td>
                <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                  <a href={`/@${account.username}/following`}>
                    {account.actor.followeesCount.toLocaleString(language)}
                  </a>
                </td>
                <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                  <a href={`/@${account.username}/followers`}>
                    {account.actor.followersCount.toLocaleString(language)}
                  </a>
                </td>
                <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                  {(postsMetadata[account.id] ?? { count: 0 }).count
                    .toLocaleString(language)}
                </td>
                <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                  <Timestamp value={account.created} locale={language} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
);
