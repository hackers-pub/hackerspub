import { page } from "@fresh/core";
import type { Account, Actor, Passkey } from "@hackerspub/models/schema";
import { Button } from "../../../../components/Button.tsx";
import { Msg } from "../../../../components/Msg.tsx";
import { PageTitle } from "../../../../components/PageTitle.tsx";
import { SettingsNav } from "../../../../components/SettingsNav.tsx";
import { db } from "../../../../db.ts";
import { ConfirmForm } from "../../../../islands/ConfirmForm.tsx";
import { PasskeyRegisterButton } from "../../../../islands/PasskeyRegisterButton.tsx";
import { Timestamp } from "../../../../islands/Timestamp.tsx";
import { define } from "../../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const account = await db.query.accountTable.findFirst({
    with: { actor: true, passkeys: true },
    where: { username: ctx.params.username },
  });
  if (account == null) return ctx.next();
  if (account.id !== ctx.state.account?.id) return ctx.next();
  return page<PasskeysPageProps>({ account });
});

export interface PasskeysPageProps {
  account: Account & { actor: Actor; passkeys: Passkey[] };
}

export default define.page<typeof handler, PasskeysPageProps>(
  ({ state: { language, t }, data: { account } }) => {
    return (
      <div>
        <SettingsNav
          active="passkeys"
          settingsHref={`/@${account.username}/settings`}
          leftInvitations={account.leftInvitations}
        />
        <div class="mt-4">
          <PageTitle
            subtitle={{ text: t("settings.passkeys.registerDescription") }}
          >
            <Msg $key="settings.passkeys.register" />
          </PageTitle>
          <PasskeyRegisterButton
            language={language}
            registrationOptionsUrl={`/@${account.username}/settings/passkeys/options`}
            verifyRegistrationUrl={`/@${account.username}/settings/passkeys/verify`}
          />
        </div>
        <div class="mt-4">
          <PageTitle
            subtitle={{ text: t("settings.passkeys.listDescription") }}
          >
            <Msg $key="settings.passkeys.list" />
          </PageTitle>
          <table class="table table-auto border-collapse border border-stone-300 dark:border-stone-500 w-full">
            <thead>
              <tr>
                <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                  <Msg $key="settings.passkeys.name" />
                </th>
                <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                  <Msg $key="settings.passkeys.lastUsed" />
                </th>
                <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                  <Msg $key="settings.passkeys.created" />
                </th>
                <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                  <Msg $key="settings.passkeys.revoke" />
                </th>
              </tr>
            </thead>
            <tbody>
              {account.passkeys.map((passkey) => (
                <tr key={passkey.id}>
                  <th class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                    {passkey.name}
                  </th>
                  <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                    {passkey.lastUsed == null
                      ? <Msg $key="settings.passkeys.neverUsed" />
                      : (
                        <Timestamp
                          locale={language}
                          value={passkey.lastUsed}
                        />
                      )}
                  </td>
                  <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                    <Timestamp locale={language} value={passkey.created} />
                  </td>
                  <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                    <ConfirmForm
                      method="post"
                      action={`/@${account.username}/settings/passkeys/revoke`}
                      confirm={t("settings.passkeys.revokeConfirm")}
                    >
                      <Button type="submit" name="id" value={passkey.id}>
                        <Msg $key="settings.passkeys.revoke" />
                      </Button>
                    </ConfirmForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  },
);
