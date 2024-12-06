import { isEmail } from "@onisaint/validate-email";
import { eq } from "drizzle-orm";
import { page } from "fresh";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Input.tsx";
import { Msg } from "../../components/Msg.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import { sendEmail } from "../../email.ts";
import { kv } from "../../kv.ts";
import { accountEmailTable } from "../../models/schema.ts";
import { createSigninToken } from "../../models/signin.ts";
import { createSignupToken } from "../../models/signup.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  GET(_ctx) {
    return page<SignPageProps>({});
  },

  async POST(ctx) {
    const { t } = ctx.state;
    const form = await ctx.req.formData();
    const email = form.get("email");
    if (typeof email !== "string" || !isEmail(email)) {
      return page<SignPageProps>({
        success: false,
        values: { email: email?.toString() },
        errors: { email: t("signInUp.invalidEmail") },
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
        subject: t("signInUp.signUpEmailSubject"),
        text: t("signInUp.signUpEmailText", { verifyUrl: verifyUrl.href }),
      });
    } else {
      const token = await createSigninToken(kv, accountEmail.accountId);
      const verifyUrl = new URL(`/sign/in/${token.token}`, ctx.url);
      verifyUrl.searchParams.set("code", token.code);
      await sendEmail({
        to: email,
        subject: t("signInUp.signInEmailSubject"),
        text: t("signInUp.signInEmailText", { verifyUrl: verifyUrl.href }),
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
        <PageTitle>
          <Msg $key="signInUp.title" />
        </PageTitle>
        {data?.success == null
          ? <SignForm />
          : data?.success === false
          ? <SignForm values={data?.values} errors={data?.errors} />
          : (
            <div class="prose dark:prose-invert">
              <p>
                <Msg
                  $key="signInUp.emailSentDescription"
                  email={<strong>{data.email}</strong>}
                />
              </p>
              <p>
                <Msg $key="signInUp.emailSentExpires" />
              </p>
              <p>
                <Msg $key="signInUp.emailSentResend" />
              </p>
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
          <Msg $key="signInUp.submit" />
        </Button>
      </form>
      <div class="prose dark:prose-invert mt-5">
        <p>
          {errors?.email ?? <Msg $key="signInUp.description" />}
        </p>
      </div>
    </>
  );
}
