import { getLogger } from "@logtape/logtape";
import { zip } from "@std/collections/zip";
import { eq } from "drizzle-orm";
import { page } from "fresh";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Input.tsx";
import { Label } from "../../components/Label.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { TextArea } from "../../components/TextArea.tsx";
import { db } from "../../db.ts";
import {
  AccountLinkFieldProps,
  AccountLinkFieldSet,
} from "../../islands/AccountLinkFieldSet.tsx";
import { accountLinkTable, accountTable } from "../../models/schema.ts";
import { define } from "../../utils.ts";
import { updateAccount, updateAccountLinks } from "../../models/account.ts";
import { syncActorFromAccount } from "../../models/actor.ts";
import { kv } from "../../kv.ts";

const logger = getLogger(["hackerspub", "routes", "@[username]", "settings"]);

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
      with: { links: { orderBy: accountLinkTable.index } },
    });
    if (account?.id !== ctx.state.session.accountId) return ctx.next();
    ctx.state.title = "Profile settings";
    return page<ProfileSettingsPageProps>({
      usernameChanged: account.usernameChanged,
      values: account,
      links: account.links,
    });
  },

  async POST(ctx) {
    ctx.state.title = "Profile settings";
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
        ? "Username is required."
        : username.length > 50
        ? "Username is too long. Maximum length is 50 characters."
        : !username.match(/^[a-z0-9_]{1,15}$/)
        ? "Username can only contain lowercase letters, numbers, and underscores."
        : account.username !== username &&
            await db.query.accountTable.findFirst({
                where: eq(accountTable.username, username),
              }) != null
        ? "Username is already taken."
        : undefined,
      name: name == null || name === ""
        ? "Name is required."
        : name.length > 50
        ? "Name is too long. Maximum length is 50 characters."
        : undefined,
      bio: bio != null && bio.length > 512
        ? "Bio is too long. Maximum length is 512 characters."
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
    };
    const updatedAccount = await updateAccount(db, values);
    if (updatedAccount == null) {
      logger.error("Failed to update account: {values}", { values });
      return ctx.next();
    }
    const updatedLinks = await updateAccountLinks(
      db,
      updatedAccount.id,
      ctx.url,
      links,
    );
    await syncActorFromAccount(db, kv, ctx.state.fedCtx, {
      ...updatedAccount,
      links: updatedLinks,
    });
    if (account.username !== updatedAccount.username) {
      return Response.redirect(
        new URL(`/@${updatedAccount.username}/settings`, ctx.url),
      );
    }
    return page<ProfileSettingsPageProps>({
      usernameChanged: updatedAccount.usernameChanged,
      values: updatedAccount,
      links: updatedLinks,
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
        <PageTitle>Profile settings</PageTitle>
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
    <form method="post" class="mt-5 grid lg:grid-cols-2 gap-5">
      <div>
        <Label label="Username" required>
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
              Your username will be used to create your profile URL and your
              fediverse handle.{" "}
              <strong>
                You can change it only once.
                {usernameChanged != null && (
                  <>
                    {" "}As you have already changed it at{" "}
                    <time datetime={usernameChanged.toString()}>
                      {usernameChanged.toLocaleString("en-US", {
                        dateStyle: "full",
                        timeStyle: "short",
                      })}
                    </time>, you can't change it again.
                  </>
                )}
              </strong>
            </p>
          )
          : <p class="text-red-700 dark:text-red-500">{errors.username}</p>}
      </div>
      <div>
        <Label label="Name" required>
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
              Your name will be displayed on your profile and in your posts.
            </p>
          )
          : <p class="text-red-700 dark:text-red-500">{errors.name}</p>}
      </div>
      <div class="lg:col-span-2">
        <Label label="Bio">
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
              Your bio will be displayed on your profile. You can use Markdown
              to format it.
            </p>
          )
          : <p class="text-red-700 dark:text-red-500">{errors.bio}</p>}
      </div>
      <div class="lg:col-span-2">
        <AccountLinkFieldSet
          links={links}
        />
      </div>
      <div class="lg:col-span-2">
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}
