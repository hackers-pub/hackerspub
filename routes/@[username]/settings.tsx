import { getLogger } from "@logtape/logtape";
import { zip } from "@std/collections/zip";
import { eq } from "drizzle-orm";
import { page } from "fresh";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Input.tsx";
import { Label } from "../../components/Label.tsx";
import { Msg, Translation } from "../../components/Msg.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { TextArea } from "../../components/TextArea.tsx";
import { db } from "../../db.ts";
import {
  type AccountLinkFieldProps,
  AccountLinkFieldSet,
} from "../../islands/AccountLinkFieldSet.tsx";
import { kv } from "../../kv.ts";
import { updateAccount } from "../../models/account.ts";
import { syncActorFromAccount } from "../../models/actor.ts";
import {
  accountEmailTable,
  accountLinkTable,
  accountTable,
} from "../../models/schema.ts";
import { define } from "../../utils.ts";

const logger = getLogger(["hackerspub", "routes", "@[username]", "settings"]);

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
      with: { links: { orderBy: accountLinkTable.index } },
    });
    if (account?.id !== ctx.state.session.accountId) return ctx.next();
    ctx.state.title = ctx.state.t("settings.profile.title");
    return page<ProfileSettingsPageProps>({
      usernameChanged: account.usernameChanged,
      values: account,
      links: account.links,
    });
  },

  async POST(ctx) {
    const { t } = ctx.state;
    ctx.state.title = t("settings.profile.title");
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
      with: { links: true },
    });
    if (account == null) return ctx.next();
    const form = await ctx.req.formData();
    const username = form.get("username")?.toString()?.trim()?.toLowerCase();
    const name = form.get("name")?.toString()?.trim();
    const bio = form.get("bio")?.toString() ?? "";
    const linkNames = form.getAll("link-name")?.map((n) => n.toString().trim());
    const linkUrls = form.getAll("link-url")?.map((u) => u.toString().trim());
    const links = zip(linkNames, linkUrls)
      .filter(([name, url]) => name !== "" && url !== "")
      .map(([name, url]) => ({ name, url }));
    const errors = {
      username: username == null || username === ""
        ? t("settings.profile.usernameRequired")
        : username.length > 50
        ? t("settings.profile.usernameTooLong")
        : !username.match(/^[a-z0-9_]{1,15}$/)
        ? t("settings.profile.usernameInvalidChars")
        : account.username !== username &&
            await db.query.accountTable.findFirst({
                where: eq(accountTable.username, username),
              }) != null
        ? t("settings.profile.usernameAlreadyTaken")
        : undefined,
      name: name == null || name === ""
        ? t("settings.profile.nameRequired")
        : name.length > 50
        ? t("settings.profile.nameTooLong")
        : undefined,
      bio: bio != null && bio.length > 512
        ? t("settings.profile.bioTooLong")
        : undefined,
    };
    if (
      username == null || name == null || errors.username || errors.name ||
      errors.bio
    ) {
      return page<ProfileSettingsPageProps>({
        usernameChanged: account.usernameChanged,
        values: { username: username ?? "", name: name ?? "", bio },
        links: account.links,
        errors,
      });
    }
    const values = {
      ...account,
      username,
      name,
      bio,
      links,
    };
    const updatedAccount = await updateAccount(db, ctx.state.fedCtx, values);
    if (updatedAccount == null) {
      logger.error("Failed to update account: {values}", { values });
      return ctx.next();
    }
    const emails = await db.query.accountEmailTable.findMany({
      where: eq(accountEmailTable.accountId, updatedAccount.id),
    });
    await syncActorFromAccount(db, kv, ctx.state.fedCtx, {
      ...updatedAccount,
      emails,
    });
    if (account.username !== updatedAccount.username) {
      return Response.redirect(
        new URL(`/@${updatedAccount.username}/settings`, ctx.url),
      );
    }
    return page<ProfileSettingsPageProps>({
      usernameChanged: updatedAccount.usernameChanged,
      values: updatedAccount,
      links: updatedAccount.links,
    });
  },
});

interface ProfileSettingsPageProps extends ProfileSettingsFormProps {
}

export default define.page<typeof handler, ProfileSettingsPageProps>(
  function ProfileSettingsPage(
    { data: { usernameChanged, values, links, errors } },
  ) {
    return (
      <div>
        <PageTitle>
          <Msg $key="settings.profile.title" />
        </PageTitle>
        <ProfileSettingsForm
          usernameChanged={usernameChanged}
          values={values}
          links={links}
          errors={errors}
        />
      </div>
    );
  },
);

interface ProfileSettingsFormProps {
  usernameChanged: Date | null;
  values: {
    username: string;
    name: string;
    bio: string;
  };
  links: AccountLinkFieldProps[];
  errors?: {
    username?: string;
    name?: string;
    bio?: string;
  };
}

function ProfileSettingsForm(
  { usernameChanged, values, links, errors }: ProfileSettingsFormProps,
) {
  return (
    <Translation>
      {(t, lang) => (
        <form method="post" class="mt-5 grid lg:grid-cols-2 gap-5">
          <div>
            <Label label={t("settings.profile.username")} required>
              <Input
                type="text"
                name="username"
                required
                class="w-full"
                pattern="^[A-Za-z0-9_]{1,50}$"
                value={values?.username}
                aria-invalid={errors?.username ? "true" : "false"}
                readOnly={usernameChanged != null}
              />
            </Label>
            {errors?.username == null
              ? (
                <p class="opacity-50">
                  <Msg $key="settings.profile.usernameDescription" />{" "}
                  <strong>
                    <Msg $key="settings.profile.usernameCaution" />
                    {usernameChanged != null && (
                      <>
                        {" "}
                        <Msg
                          $key="settings.profile.usernameChanged"
                          changed={
                            <time datetime={usernameChanged.toString()}>
                              {usernameChanged.toLocaleString(lang, {
                                dateStyle: "full",
                                timeStyle: "short",
                              })}
                            </time>
                          }
                        />
                      </>
                    )}
                  </strong>
                </p>
              )
              : <p class="text-red-700 dark:text-red-500">{errors.username}</p>}
          </div>
          <div>
            <Label label={t("settings.profile.name")} required>
              <Input
                type="text"
                name="name"
                required
                class="w-full"
                pattern="^.{1,50}$"
                value={values?.name}
                aria-invalid={errors?.name ? "true" : "false"}
              />
            </Label>
            {errors?.name == null
              ? (
                <p class="opacity-50">
                  <Msg $key="settings.profile.nameDescription" />
                </p>
              )
              : <p class="text-red-700 dark:text-red-500">{errors.name}</p>}
          </div>
          <div class="lg:col-span-2">
            <Label label={t("settings.profile.bio")}>
              <TextArea
                name="bio"
                cols={80}
                rows={7}
                class="w-full"
                value={values?.bio}
                aria-invalid={errors?.bio ? "true" : "false"}
              />
            </Label>
            {errors?.bio == null
              ? (
                <p class="opacity-50">
                  <Msg $key="settings.profile.bioDescription" />
                </p>
              )
              : <p class="text-red-700 dark:text-red-500">{errors.bio}</p>}
          </div>
          <div class="lg:col-span-2">
            <AccountLinkFieldSet links={links} language={lang} />
          </div>
          <div class="lg:col-span-2">
            <Button type="submit">
              <Msg $key="settings.profile.save" />
            </Button>
          </div>
        </form>
      )}
    </Translation>
  );
}
