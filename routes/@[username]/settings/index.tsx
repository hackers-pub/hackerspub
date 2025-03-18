import { getLogger } from "@logtape/logtape";
import { zip } from "@std/collections/zip";
import { eq } from "drizzle-orm";
import { page } from "fresh";
import sharp from "sharp";
import { Button } from "../../../components/Button.tsx";
import { Input } from "../../../components/Input.tsx";
import { Label } from "../../../components/Label.tsx";
import { Msg, Translation } from "../../../components/Msg.tsx";
import { SettingsNav } from "../../../components/SettingsNav.tsx";
import { TextArea } from "../../../components/TextArea.tsx";
import { db } from "../../../db.ts";
import { drive } from "../../../drive.ts";
import {
  type AccountLinkFieldProps,
  AccountLinkFieldSet,
} from "../../../islands/AccountLinkFieldSet.tsx";
import { Timestamp } from "../../../islands/Timestamp.tsx";
import { kv } from "../../../kv.ts";
import { getAvatarUrl, updateAccount } from "../../../models/account.ts";
import { syncActorFromAccount } from "../../../models/actor.ts";
import {
  accountEmailTable,
  accountLinkTable,
  accountTable,
} from "../../../models/schema.ts";
import { define } from "../../../utils.ts";

const logger = getLogger(["hackerspub", "routes", "@[username]", "settings"]);

const SUPPORTED_AVATAR_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];
const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5 MiB

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
      with: { emails: true, links: { orderBy: accountLinkTable.index } },
    });
    if (account?.id !== ctx.state.session.accountId) return ctx.next();
    ctx.state.title = ctx.state.t("settings.profile.title");
    return page<ProfileSettingsPageProps>({
      avatarUrl: await getAvatarUrl(account),
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
      with: { emails: true, links: true },
    });
    if (account == null) return ctx.next();
    const form = await ctx.req.formData();
    const avatar = form.get("avatar");
    const username = form.get("username")?.toString()?.trim()?.toLowerCase();
    const name = form.get("name")?.toString()?.trim();
    const bio = form.get("bio")?.toString() ?? "";
    const linkNames = form.getAll("link-name")?.map((n) => n.toString().trim());
    const linkUrls = form.getAll("link-url")?.map((u) => u.toString().trim());
    const links = zip(linkNames, linkUrls)
      .filter(([name, url]) => name !== "" && url !== "" && url != null)
      .map(([name, url]) => ({ name, url }));
    const errors = {
      avatar: avatar == null || avatar === ""
        ? undefined
        : !(avatar instanceof File) ||
            !SUPPORTED_AVATAR_TYPES.includes(avatar.type)
        ? t("settings.profile.avatarInvalid")
        : avatar instanceof File && avatar.size > MAX_AVATAR_SIZE
        ? t("settings.profile.avatarTooLarge")
        : undefined,
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
      errors.avatar || username == null || name == null || errors.username ||
      errors.name ||
      errors.bio
    ) {
      return page<ProfileSettingsPageProps>({
        avatarUrl: await getAvatarUrl(account),
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
    const promises: Promise<void>[] = [];
    if (avatar instanceof File) {
      const disk = drive.use();
      if (account.avatarKey != null) {
        promises.push(disk.delete(account.avatarKey));
      }
      let image = sharp(await avatar.arrayBuffer());
      const metadata = await image.metadata();
      let { width, height } = metadata;
      if (width == null || height == null) {
        // FIXME: This should be a proper error message.
        throw new Error("Failed to read image metadata.");
      }
      if (width !== height) { // crop to square
        const size = Math.min(width, height);
        const left = (width - size) / 2;
        const top = (height - size) / 2;
        image = image.extract({ left, top, width: size, height: size });
        width = height = size;
      }
      if (width > 1024) {
        image = image.resize(1024);
        width = height = 1024;
      }
      if (metadata.format !== "jpeg") image = image.jpeg({ quality: 90 });
      const buffer = await image.toBuffer();
      const key = `avatars/${crypto.randomUUID()}.jpg`;
      promises.push(disk.put(key, new Uint8Array(buffer.buffer)));
      values.avatarKey = key;
    }
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
    await Promise.all(promises);
    if (account.username !== updatedAccount.username) {
      return Response.redirect(
        new URL(`/@${updatedAccount.username}/settings`, ctx.url),
      );
    }
    return page<ProfileSettingsPageProps>({
      avatarUrl: await getAvatarUrl({ ...updatedAccount, emails }),
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
    { data: { avatarUrl, usernameChanged, values, links, errors } },
  ) {
    return (
      <div>
        <SettingsNav
          active="profile"
          settingsHref={`/@${values.username}/settings`}
        />
        <ProfileSettingsForm
          avatarUrl={avatarUrl}
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
  avatarUrl: string;
  usernameChanged: Date | null;
  values: {
    username: string;
    name: string;
    bio: string;
  };
  links: AccountLinkFieldProps[];
  errors?: {
    avatar?: string;
    username?: string;
    name?: string;
    bio?: string;
  };
}

function ProfileSettingsForm(
  { avatarUrl, usernameChanged, values, links, errors }:
    ProfileSettingsFormProps,
) {
  return (
    <Translation>
      {(t, lang) => (
        <form
          method="post"
          encType="multipart/form-data"
          class="mt-5 grid lg:grid-cols-2 gap-5"
        >
          <div class="lg:col-span-2 flex flex-row">
            <img
              src={avatarUrl}
              width={128}
              height={128}
              class="mr-5 w-20 h-20"
            />
            <div>
              <Label label={t("settings.profile.avatar")}>
                <Input
                  type="file"
                  name="avatar"
                  accept="image/jpeg, image/png, image/gif, image/webp"
                  class="w-full lg:w-auto"
                />
              </Label>
              {errors?.avatar == null
                ? (
                  <p class="opacity-50">
                    <Msg $key="settings.profile.avatarDescription" />
                  </p>
                )
                : (
                  <p class="text-red-700 dark:text-red-500">
                    {errors.avatar}
                  </p>
                )}
            </div>
          </div>
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
                            <Timestamp
                              value={usernameChanged}
                              locale={lang}
                            />
                          }
                        />
                      </>
                    )}
                  </strong>
                </p>
              )
              : (
                <p class="text-red-700 dark:text-red-500">
                  {errors.username}
                </p>
              )}
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
