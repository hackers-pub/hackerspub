import { eq } from "drizzle-orm";
import { page } from "fresh";
import { AdminNav } from "../../components/AdminNav.tsx";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Input.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import { Timestamp } from "../../islands/Timestamp.tsx";
import {
  accountEmailTable,
  type AllowedEmail,
  allowedEmailTable,
} from "../../models/schema.ts";
import { define } from "../../utils.ts";

function getAllowedEmails(): Promise<
  (AllowedEmail & { consumed: Date | null })[]
> {
  return db.select({
    email: allowedEmailTable.email,
    created: allowedEmailTable.created,
    consumed: accountEmailTable.created,
  }).from(allowedEmailTable).leftJoin(
    accountEmailTable,
    eq(allowedEmailTable.email, accountEmailTable.email),
  ).execute();
}

export const handler = define.handlers({
  async GET(_ctx) {
    return page<AllowListProps>({
      allowedEmails: await getAllowedEmails(),
    });
  },

  async POST(ctx) {
    const form = await ctx.req.formData();
    const email = form.get("email")?.toString()?.trim();
    if (email != null && email !== "") {
      await db.insert(allowedEmailTable).values({ email }).execute();
    }
    return page<AllowListProps>({
      allowedEmails: await getAllowedEmails(),
    });
  },
});

interface AllowListProps {
  allowedEmails: (AllowedEmail & { consumed: Date | null })[];
}

export default define.page<typeof handler, AllowListProps>(
  function AllowList({ state: { language }, data: { allowedEmails } }) {
    return (
      <div>
        <AdminNav active="allowlist" />
        <PageTitle>Allowed emails</PageTitle>
        <table class="table table-auto border-collapse border border-stone-300 dark:border-stone-500 w-full">
          <thead>
            <tr>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                Email
              </th>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                Created
              </th>
              <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                Consumed
              </th>
            </tr>
          </thead>
          <tbody>
            {allowedEmails.map((email) => (
              <tr>
                <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                  {email.email}
                </td>
                <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                  <Timestamp value={email.created} locale={language} />
                </td>
                <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                  {email.consumed == null
                    ? "N/A"
                    : <Timestamp value={email.consumed} locale={language} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <PageTitle class="mt-5">Allow new email</PageTitle>
        <form method="post" class="mt-5 grid grid-cols-2 gap-5">
          <div>
            <Input
              type="email"
              name="email"
              class="w-full"
              placeholder="Email address"
              required
            />
          </div>
          <div>
            <Button type="submit">Allow</Button>
          </div>
        </form>
      </div>
    );
  },
);
