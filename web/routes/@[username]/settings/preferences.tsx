import { page } from "@fresh/core";
import { accountTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import { Button } from "../../../components/Button.tsx";
import { Msg } from "../../../components/Msg.tsx";
import { Label } from "../../../components/Label.tsx";
import { SettingsNav } from "../../../components/SettingsNav.tsx";
import { db } from "../../../db.ts";
import { define } from "../../../utils.ts";
import type { PostVisibility } from "@hackerspub/models/schema";
import { DefaultVisibilityPreference } from "../../../islands/DefaultVisibilityPreference.tsx";

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
    const noteVisibility = form.get("noteVisibility") as PostVisibility;
    const shareVisibility = form.get("shareVisibility") as PostVisibility;

    const accounts = await db.update(accountTable)
      .set({ preferAiSummary, postVisibility, shareVisibility })
      .where(eq(accountTable.id, ctx.state.account.id))
      .returning();
    return page<PreferencesPageProps>(accounts[0]);
  },
});

interface PreferencesPageProps {
  preferAiSummary: boolean;
  leftInvitations: number;
  postVisibility: PostVisibility;
  shareVisibility: PostVisibility;
}

export default define.page<typeof handler, PreferencesPageProps>((
  { state: { language, t }, data, params },
) => {
  return (
    <div>
      <SettingsNav
        active="preferences"
        settingsHref={`/@${params.username}/settings`}
        leftInvitations={data.leftInvitations}
      />
      <form method="post" class="mt-4">
        <Label label={t("settings.preferences.preferAiSummary")}>
          <input
            type="checkbox"
            name="preferAiSummary"
            checked={data.preferAiSummary}
            value="true"
          />{" "}
          <Msg $key="settings.preferences.preferAiSummary" />
          <p class="opacity-50">
            <Msg $key="settings.preferences.preferAiSummaryDescription" />
          </p>
        </Label>
        <DefaultVisibilityPreference
          language={language}
          noteVisibility={data.noteVisibility}
          shareVisibility={data.shareVisibility}
        />
        <Button type="submit" class="mt-4">
          <Msg $key="settings.preferences.save" />
        </Button>
      </form>
    </div>
  );
});
