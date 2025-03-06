import { page } from "fresh";
import { AdminNav } from "../../components/AdminNav.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import { Timestamp } from "../../islands/Timestamp.tsx";
import { getAvatarUrl } from "../../models/account.ts";
import type { Account, AccountEmail, Actor } from "../../models/schema.ts";
import type { Uuid } from "../../models/uuid.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(_ctx) {
    const accounts = await db.query.accountTable.findMany({
      with: { emails: true, actor: true },
    });
    const avatars = Object.fromEntries(
      await Promise.all(
        accounts.map(async (
          account,
        ) => [account.id, await getAvatarUrl(account)]),
      ),
    );
    return page<AccountListProps>({ accounts, avatars });
  },
});

interface AccountListProps {
  accounts: (Account & { actor: Actor; emails: AccountEmail[] })[];
  avatars: Record<Uuid, string>;
}

export default define.page<typeof handler, AccountListProps>(
  function AccountList({ state: { language }, data: { accounts, avatars } }) {
    return (
      <div>
        <AdminNav active="accounts" />
        <PageTitle>Accounts</PageTitle>
        <table class="table table-auto border-collapse border border-stone-500 w-full">
          <thead>
            <tr>
              <th class="border border-stone-500 bg-stone-700 p-2">ID</th>
              <th class="border border-stone-500 bg-stone-700 p-2">Avatar</th>
              <th class="border border-stone-500 bg-stone-700 p-2">Username</th>
              <th class="border border-stone-500 bg-stone-700 p-2">Name</th>
              <th class="border border-stone-500 bg-stone-700 p-2">
                Following
              </th>
              <th class="border border-stone-500 bg-stone-700 p-2">
                Followers
              </th>
              <th class="border border-stone-500 bg-stone-700 p-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr>
                <th class="border border-stone-500 bg-stone-800 p-2">
                  {account.id}
                </th>
                <td class="border border-stone-500 bg-stone-800 w-[64px]">
                  <a href={`/@${account.username}`}>
                    <img
                      src={avatars[account.id]}
                      width={64}
                      height={64}
                      alt={account.name}
                    />
                  </a>
                </td>
                <td class="border border-stone-500 bg-stone-800 p-2">
                  <a href={`/@${account.username}`}>{account.username}</a>
                </td>
                <td class="border border-stone-500 bg-stone-800 p-2">
                  <a href={`/@${account.username}`}>{account.name}</a>
                </td>
                <td class="border border-stone-500 bg-stone-800 p-2">
                  {account.actor.followeesCount.toLocaleString(language)}
                </td>
                <td class="border border-stone-500 bg-stone-800 p-2">
                  {account.actor.followersCount.toLocaleString(language)}
                </td>
                <td class="border border-stone-500 bg-stone-800 p-2">
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
