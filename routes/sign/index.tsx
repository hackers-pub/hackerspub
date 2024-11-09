import { isEmail } from "@onisaint/validate-email";
import { eq } from "drizzle-orm";
import { page } from "fresh";
import { accountEmailTable } from "../../models/schema.ts";
import { createSigninToken } from "../../models/signin.ts";
import { createSignupToken } from "../../models/signup.ts";
import { PageTitle } from "../../components/PageTitle.tsx";
import { Input } from "../../components/Input.tsx";
import { Button } from "../../components/Button.tsx";
import { db } from "../../db.ts";
import { sendEmail } from "../../email.ts";
import { kv } from "../../kv.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  GET(_ctx) {
    return page<SignPageProps>({});
  },

  async POST(ctx) {
    const form = await ctx.req.formData();
    const email = form.get("email");
    if (typeof email !== "string" || !isEmail(email)) {
      return page<SignPageProps>({
        success: false,
        values: { email: email?.toString() },
        errors: { email: "Invalid email address." },
      });
    }
    const accountEmail = await db.query.accountEmailTable.findFirst({
      where: eq(accountEmailTable.email, email),
    });
    if (accountEmail == null) {
      const token = await createSignupToken(kv, email);
      const verifyUrl = new URL(`/sign/up/${token.token}`, ctx.url);
      verifyUrl.searchParams.set("code", token.code);
      await sendEmail({
        to: email,
        subject: "Sign up for Hackers' Pub",
        text: `Welcome to Hackers' Pub! To sign up, click the following link:

${verifyUrl.href}

This link will expire in 24 hours.

If you didn't request this email, you can safely ignore it.
`,
      });
    } else {
      const token = await createSigninToken(kv, accountEmail.accountId);
      const verifyUrl = new URL(`/sign/in/${token.token}`, ctx.url);
      verifyUrl.searchParams.set("code", token.code);
      await sendEmail({
        to: email,
        subject: "Sign in to Hackers' Pub",
        text:
          `Welcome back to Hackers' Pub! To sign in, click the following link:

${verifyUrl.href}

This link will expire in 24 hours.

If you didn't request this email, you can safely ignore it.
`,
      });
    }
    return page<SignPageProps>({ success: true, email });
  },
});

type SignPageProps =
  | { success?: undefined }
  | { success: false } & SignFormProps
  | { success: true; email: string };

export default define.page<typeof handler, SignPageProps>(
  function SignPage({ data }) {
    return (
      <div>
        <PageTitle>Sign in/up</PageTitle>
        {data?.success == null
          ? <SignForm />
          : data?.success === false
          ? <SignForm values={data?.values} errors={data?.errors} />
          : (
            <div class="prose dark:prose-invert">
              <p>
                An email has been sent to <strong>{data.email}</strong>{" "}
                with a sign-in/up link. Please check your inbox. If you don't
                see it, check your spam folder.
              </p>
              <p>Note that the link will expire in 24 hours.</p>
              <p>You can always request a new link by signing in/up again.</p>
            </div>
          )}
      </div>
    );
  },
);

interface SignFormProps {
  values?: {
    email?: string;
  };
  errors?: {
    email?: string;
  };
}

function SignForm({ values, errors }: SignFormProps) {
  return (
    <>
      <form method="post" class="flex flex-row gap-x-3">
        <Input
          type="email"
          name="email"
          class="grow lg:text-xl"
          placeholder="your@email.com"
          required
          aria-invalid={errors?.email ? true : false}
          value={values?.email}
        />
        <Button
          type="submit"
          class="basis-1/7 lg:text-xl"
        >
          Sign in/up
        </Button>
      </form>
      <div class="prose dark:prose-invert mt-5">
        <p>
          {errors?.email ??
            "If you have an account, we'll send you a sign-in link. If you don't have an account, we'll send you a sign-up link."}
        </p>
      </div>
    </>
  );
}
