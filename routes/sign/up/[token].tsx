import { setCookie } from "@std/http/cookie";
import { eq } from "drizzle-orm";
import { page } from "fresh";
import { PageTitle } from "../../../components/PageTitle.tsx";
import { accountEmailTable, accountTable } from "../../../models/schema.ts";
import { createSession, EXPIRATION } from "../../../models/session.ts";
import {
  createAccount,
  deleteSignupToken,
  getSignupToken,
  type SignupToken,
} from "../../../models/signup.ts";
import { Input } from "../../../components/Input.tsx";
import { TextArea } from "../../../components/TextArea.tsx";
import { Label } from "../../../components/Label.tsx";
import { Button } from "../../../components/Button.tsx";
import { kv } from "../../../kv.ts";
import { db } from "../../../db.ts";
import { define } from "../../../utils.ts";
import { syncActorFromAccount } from "../../../models/actor.ts";
import { generateUuidV7, validateUuid } from "../../../models/uuid.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.token)) return ctx.next();
    const token = await getSignupToken(kv, ctx.params.token);
    if (token == null) return ctx.next();
    const code = ctx.url.searchParams.get("code");
    const invalidCode = code !== token.code ||
      await db.query.accountEmailTable.findFirst({
          where: eq(accountEmailTable.email, token.email),
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
          where: eq(accountEmailTable.email, token.email),
        }) != null
    ) {
      return page<SignupPageProps>({ token, invalidCode: true });
    }
    const username = form.get("username")?.toString()?.trim()?.toLowerCase();
    const name = form.get("name")?.toString()?.trim();
    const bio = form.get("bio")?.toString() ?? "";
    const errors = {
      username: username == null || username === ""
        ? "Username is required."
        : username.length > 50
        ? "Username is too long. Maximum length is 50 characters."
        : !username.match(/^[a-z0-9_]{1,15}$/)
        ? "Username can only contain lowercase letters, numbers, and underscores."
        : await db.query.accountTable.findFirst({
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
    });
    if (account == null) {
      return page<SignupPageProps>({
        token,
        values: { username, name, bio },
        errors,
      });
    }
    await syncActorFromAccount(db, kv, ctx.state.fedCtx, {
      ...account,
      links: [],
    });
    await deleteSignupToken(kv, token.token);
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
    headers.set("Location", "/");
    return new Response(null, { status: 301, headers });
  },
});

interface SignupPageProps extends SignupFormProps {
  invalidCode?: boolean;
}

export default define.page<typeof handler, SignupPageProps>(
  function SignupPage({ data: { invalidCode, token, errors, values } }) {
    return (
      <div>
        <PageTitle>Sign up</PageTitle>
        {invalidCode
          ? (
            <p>
              The sign-up link is invalid. Please make sure you're using the
              correct link from the email you received.
            </p>
          )
          : (
            <>
              <p>
                Welcome to Hackers' Pub! Please fill out the form below to
                complete your sign-up.
              </p>
              <SignupForm token={token} errors={errors} values={values} />
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
}

function SignupForm({ token, values, errors }: SignupFormProps) {
  return (
    <form method="post" class="mt-5 grid lg:grid-cols-2 gap-5">
      <div class="lg:col-span-2">
        <Label label="Email address" required>
          <Input
            type="email"
            name="email"
            value={token.email}
            disabled
            class="w-full lg:w-1/2"
          />
        </Label>
        <p class="opacity-50">
          Your email address will be used to sign in to your account.
        </p>
      </div>
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
          />
        </Label>
        {errors?.username == null
          ? (
            <p class="opacity-50">
              Your username will be used to create your profile URL and your
              fediverse handle.
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
      <div>
        <input type="hidden" name="code" value={token.code} />
        <Button type="submit">Sign up</Button>
      </div>
    </form>
  );
}
