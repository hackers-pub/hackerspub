import { eq } from "drizzle-orm";
import { page } from "fresh";
import { Button } from "../../../components/Button.tsx";
import { Msg } from "../../../components/Msg.tsx";
import { SettingsNav } from "../../../components/SettingsNav.tsx";
import { db } from "../../../db.ts";
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  isLocale,
  type Locale,
} from "../../../i18n.ts";
import { LocalePriorityList } from "../../../islands/LocalePriorityList.tsx";
import { type Account, accountTable } from "../../../models/schema.ts";
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
    await db.update(accountTable)
      .set({ locales: locales.length < 1 ? null : locales })
      .where(eq(accountTable.id, account.id));
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
        />
        <LocalePriorityList
          language={state.language}
          name="locales"
          selectedLocales={locales}
          class="mt-4"
        />
        <Button type="submit" class="mt-4 w-full">
          <Msg $key="settings.language.save" />
        </Button>
      </form>
    );
  },
);
