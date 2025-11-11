import { page } from "@fresh/core";
import { syncActorFromAccount } from "@hackerspub/models/actor";
import { follow } from "@hackerspub/models/following";
import { renderMarkup } from "@hackerspub/models/markup";
import { createSession, EXPIRATION } from "@hackerspub/models/session";
import { USERNAME_REGEXP } from "@hackerspub/models/signin";
import {
  createAccount,
  deleteSignupToken,
  getSignupToken,
  type SignupToken,
} from "@hackerspub/models/signup";
import { generateUuidV7, validateUuid } from "@hackerspub/models/uuid";
import { setCookie } from "@std/http/cookie";
import { dirname } from "@std/path/dirname";
import { join } from "@std/path/join";
import { Button } from "../../../components/Button.tsx";
import { Input } from "../../../components/Input.tsx";
import { Label } from "../../../components/Label.tsx";
import { Msg, Translation } from "../../../components/Msg.tsx";
import { PageTitle } from "../../../components/PageTitle.tsx";
import { TextArea } from "../../../components/TextArea.tsx";
import { db } from "../../../db.ts";
import { kv } from "../../../kv.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.token)) return ctx.next();
    const token = await getSignupToken(kv, ctx.params.token);
    if (token == null) return ctx.next();
    const code = ctx.url.searchParams.get("code");
    const invalidCode = code !== token.code ||
      await db.query.accountEmailTable.findFirst({
          where: { email: token.email },
        }) != null;
    return page<SignupPageProps>({ invalidCode, token });
  },

  async POST(ctx) {
    if (!validateUuid(ctx.params.token)) return ctx.next();
    const token = await getSignupToken(kv, ctx.params.token);
    if (token == null) return ctx.next();
    const form = await ctx.req.formData();
    const code = form.get("code");
    if (
      code !== token.code || await db.query.accountEmailTable.findFirst({
          where: { email: token.email },
        }) != null
    ) {
      return page<SignupPageProps>({ token, invalidCode: true });
    }
    const { t } = ctx.state;
    const username = form.get("username")?.toString()?.trim()?.toLowerCase();
    const name = form.get("name")?.toString()?.trim();
    const bio = form.get("bio")?.toString() ?? "";
    const errors = {
      username: username == null || username === ""
        ? t("signUp.usernameRequired")
        : username.length > 50
        ? t("signUp.usernameTooLong")
        : !username.match(USERNAME_REGEXP)
        ? t("signUp.usernameInvalidChars")
        : await db.query.accountTable.findFirst({
            where: { username },
          }) != null
        ? t("signUp.usernameAlreadyTaken")
        : undefined,
      name: name == null || name === ""
        ? t("signUp.nameRequired")
        : name.length > 50
        ? t("signUp.nameTooLong")
        : undefined,
      bio: bio != null && bio.length > 512 ? t("signUp.bioTooLong") : undefined,
    };
    if (
      username == null || name == null || errors.username || errors.name ||
      errors.bio
    ) {
      return page<SignupPageProps>({
        token,
        values: { username, name, bio },
        errors,
      });
    }
    const account = await createAccount(db, token, {
      id: generateUuidV7(),
      username,
      name,
      bio,
      leftInvitations: 0,
    });
    if (account == null) {
      return page<SignupPageProps>({
        token,
        values: { username, name, bio },
        errors,
      });
    }
    const actor = await syncActorFromAccount(ctx.state.fedCtx, {
      ...account,
      links: [],
    });
    await deleteSignupToken(kv, token.token);
    const inviter = token.inviterId == null
      ? null
      : await db.query.accountTable.findFirst({
        where: { id: token.inviterId },
        with: { actor: true },
      });
    if (inviter != null) {
      await follow(ctx.state.fedCtx, { ...account, actor }, inviter.actor);
      await follow(ctx.state.fedCtx, inviter, actor);
    }
    const session = await createSession(kv, {
      accountId: account.id,
      userAgent: ctx.req.headers.get("user-agent") ?? null,
      ipAddress: ctx.info.remoteAddr.transport === "tcp"
        ? ctx.info.remoteAddr.hostname
        : null,
    });
    const headers = new Headers();
    setCookie(headers, {
      name: "session",
      value: session.id,
      path: "/",
      expires: new Date(Temporal.Now.instant().add(EXPIRATION).toString()),
      secure: ctx.url.protocol === "https:",
    });
    headers.set("Location", "/?filter=recommendations");
    return new Response(null, { status: 302, headers });
  },
});

interface SignupPageProps {
  invalidCode?: boolean;
  token: SignupToken;
  errors?: {
    username?: string;
    name?: string;
    bio?: string;
  };
  values?: {
    username?: string;
    name?: string;
    bio?: string;
  };
}

export default define.page<typeof handler, SignupPageProps>(
  async function SignupPage(
    {
      state: { language, fedCtx },
      data: { invalidCode, token, errors, values },
    },
  ) {
    const coc = await Deno.readTextFile(
      join(
        dirname(dirname(dirname(dirname(import.meta.dirname!)))),
        `CODE_OF_CONDUCT.${language}.md`,
      ),
    );
    const rendered = await renderMarkup(fedCtx, coc, { kv });
    const cocHtml = rendered.html;
    return (
      <div>
        <PageTitle>
          <Msg $key="signUp.title" />
        </PageTitle>
        {invalidCode
          ? (
            <p>
              <Msg $key="signUp.invalidCode" />
            </p>
          )
          : (
            <>
              <p>
                <Msg $key="signUp.welcome" />
              </p>
              <SignupForm
                token={token}
                errors={errors}
                values={values}
                cocHtml={cocHtml}
              />
            </>
          )}
      </div>
    );
  },
);

interface SignupFormProps {
  token: SignupToken;
  errors?: {
    username?: string;
    name?: string;
    bio?: string;
  };
  values?: {
    username?: string;
    name?: string;
    bio?: string;
  };
  cocHtml: string;
}

function SignupForm({ token, values, errors, cocHtml }: SignupFormProps) {
  return (
    <Translation>
      {(t) => (
        <form method="post" class="mt-5 grid lg:grid-cols-2 gap-5">
          <div class="lg:col-span-2">
            <Label label={t("signUp.email")} required>
              <Input
                type="email"
                name="email"
                value={token.email}
                disabled
                class="w-full lg:w-1/2"
              />
            </Label>
            <p class="opacity-50">
              <Msg $key="signUp.emailDescription" />
            </p>
          </div>
          <div>
            <Label label={t("signUp.username")} required>
              <Input
                type="text"
                name="username"
                required
                class="w-full"
                pattern="^[A-Za-z0-9_]{1,50}$"
                title={t("signUp.usernamePattern")}
                value={values?.username}
                aria-invalid={errors?.username ? "true" : "false"}
              />
            </Label>
            {errors?.username == null
              ? (
                <p class="opacity-50">
                  <Msg $key="signUp.usernameDescription" />
                </p>
              )
              : <p class="text-red-700 dark:text-red-500">{errors.username}</p>}
          </div>
          <div>
            <Label label={t("signUp.name")} required>
              <Input
                type="text"
                name="name"
                required
                class="w-full"
                pattern="^.{1,50}$"
                title={t("signUp.namePattern")}
                value={values?.name}
                aria-invalid={errors?.name ? "true" : "false"}
              />
            </Label>
            {errors?.name == null
              ? (
                <p class="opacity-50">
                  <Msg $key="signUp.nameDescription" />
                </p>
              )
              : <p class="text-red-700 dark:text-red-500">{errors.name}</p>}
          </div>
          <div class="lg:col-span-2">
            <Label label={t("signUp.bio")}>
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
                  <Msg $key="signUp.bioDescription" />
                </p>
              )
              : <p class="text-red-700 dark:text-red-500">{errors.bio}</p>}
          </div>
          <div class="lg:col-span-2">
            <strong>
              <Msg $key="signUp.coc" />
            </strong>
            <article
              class="
                border p-4
                dark:border-stone-500 dark:bg-stone-900
                prose dark:prose-invert h-96 overflow-y-scroll
                max-w-full
              "
              dangerouslySetInnerHTML={{ __html: cocHtml }}
            />
            <p class="opacity-50">
              <Msg $key="signUp.cocDescription" />
            </p>
          </div>
          <div class="lg:col-span-2">
            <input type="hidden" name="code" value={token.code} />
            <div class="mx-auto text-center">
              <Button type="submit">
                <Msg $key="signUp.submit" />
              </Button>
            </div>
          </div>
        </form>
      )}
    </Translation>
  );
}
