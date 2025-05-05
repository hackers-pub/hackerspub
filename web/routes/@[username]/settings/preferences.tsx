import { page } from "@fresh/core";
import { eq } from "drizzle-orm";
import { accountTable } from "../../../../models/schema.ts";
import { Button } from "../../../components/Button.tsx";
import { Msg } from "../../../components/Msg.tsx";
import { SettingsNav } from "../../../components/SettingsNav.tsx";
import { db } from "../../../db.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers({
  GET(ctx) {
    if (
      ctx.state.account?.username !== ctx.params.username
    ) {
      return ctx.next();
    }
    return page<PreferencesPageProps>(ctx.state.account);
  },
  async POST(ctx) {
    if (
      ctx.state.account?.username !== ctx.params.username
    ) {
      return ctx.next();
    }
    const form = await ctx.req.formData();
    const preferAiSummary = form.get("preferAiSummary") === "true";
    const accounts = await db.update(accountTable)
      .set({ preferAiSummary })
      .where(eq(accountTable.id, ctx.state.account.id))
      .returning();
    return page<PreferencesPageProps>(accounts[0]);
  },
});

interface PreferencesPageProps {
  preferAiSummary: boolean;
  leftInvitations: number;
}

export default define.page<typeof handler, PreferencesPageProps>((
  { data, params },
) => (
  <div>
    <SettingsNav
      active="preferences"
      settingsHref={`/@${params.username}/settings`}
      leftInvitations={data.leftInvitations}
    />
    <form method="post" class="mt-4">
      <label>
        <input
          type="checkbox"
          name="preferAiSummary"
          checked={data.preferAiSummary}
          value="true"
        />{" "}
        <Msg $key="settings.preferences.preferAiSummary" />
      </label>
      <p class="opacity-50">
        <Msg $key="settings.preferences.preferAiSummaryDescription" />
      </p>
      <Button type="submit" class="mt-4">
        <Msg $key="settings.preferences.save" />
      </Button>
    </form>
  </div>
));
