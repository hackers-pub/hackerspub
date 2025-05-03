import { page } from "@fresh/core";
import { isLocale, type Locale } from "@hackerspub/models/i18n";
import { type Account, accountTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import { Button } from "../../../components/Button.tsx";
import { Msg } from "../../../components/Msg.tsx";
import { SettingsNav } from "../../../components/SettingsNav.tsx";
import { db } from "../../../db.ts";
import { DEFAULT_LANGUAGE, isLanguage } from "../../../i18n.ts";
import { LocalePriorityList } from "../../../islands/LocalePriorityList.tsx";
import { define } from "../../../utils.ts";

export const handler = define.handlers({
  GET(ctx) {
    const { account } = ctx.state;
    if (account == null || account.username !== ctx.params.username) {
      return ctx.next();
    }
    return page<LanguageSettingsPageProps>({
      account,
      locales: ctx.state.locales,
    });
  },

  async POST(ctx) {
    const { account } = ctx.state;
    if (account == null || account.username !== ctx.params.username) {
      return ctx.next();
    }
    const form = await ctx.req.formData();
    const locales = form.getAll("locales").map(String).filter(isLocale);
    const hideForeignLanguages = form.get("hideForeignLanguages") === "true";
    await db.update(accountTable)
      .set({
        locales: locales.length < 1 ? null : locales,
        hideForeignLanguages,
      })
      .where(eq(accountTable.id, account.id));
    account.hideForeignLanguages = hideForeignLanguages;
    ctx.state.locales = locales;
    ctx.state.language = locales.find(isLanguage) ?? DEFAULT_LANGUAGE;
    return page<LanguageSettingsPageProps>({ account, locales });
  },
});

interface LanguageSettingsPageProps {
  account: Account;
  locales: Locale[];
}

export default define.page<typeof handler, LanguageSettingsPageProps>(
  function LanguageSettingsPage({ state, data: { account, locales } }) {
    return (
      <form method="post">
        <SettingsNav
          active="language"
          settingsHref={`/@${account.username}/settings`}
          leftInvitations={account.leftInvitations}
        />
        <LocalePriorityList
          language={state.language}
          name="locales"
          selectedLocales={locales}
          class="my-4"
        />
        <label class="cursor-pointer">
          <input
            type="checkbox"
            name="hideForeignLanguages"
            value="true"
            checked={account.hideForeignLanguages}
            class="mr-1"
          />
          <Msg $key="settings.language.hideForeignLanguages" />
        </label>
        <Button type="submit" class="mt-4 w-full">
          <Msg $key="settings.language.save" />
        </Button>
      </form>
    );
  },
);
