import { page } from "@fresh/core";
import {
  createSigninToken,
  EXPIRATION as SIGNIN_EXPIRATION,
  USERNAME_REGEXP,
} from "@hackerspub/models/signin";
import { isEmail } from "@onisaint/validate-email";
import { getFixedT } from "i18next";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Input.tsx";
import { Label } from "../../components/Label.tsx";
import { Msg } from "../../components/Msg.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import { sendEmail } from "../../email.ts";
import { SignForm, type SignFormProps } from "../../islands/SignForm.tsx";
import { kv } from "../../kv.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  GET(_ctx) {
    return page<SignPageProps>({});
  },

  async POST(ctx) {
    const { t } = ctx.state;
    const form = await ctx.req.formData();
    const email = form.get("email");
    if (
      typeof email !== "string" ||
      !isEmail(email) && !USERNAME_REGEXP.test(email)
    ) {
      return page<SignPageProps>({
        success: false,
        values: { email: email?.toString() },
        errors: { email: t("signInUp.invalidEmailOrUsername") },
      });
    }
    const account = await db.query.accountTable.findFirst({
      where: {
        OR: [
          { username: email },
          { emails: { email } },
        ],
      },
      with: { emails: true },
    });
    let expiration: Temporal.Duration;
    let signInToken: string;
    if (account == null) {
      return page<SignPageProps>({
        success: false,
        values: { email },
        errors: { email: t("signInUp.noSuchEmailOrUsername") },
      });
    } else {
      const token = await createSigninToken(kv, account.id);
      const verifyUrl = new URL(`/sign/in/${token.token}`, ctx.url);
      verifyUrl.searchParams.set("code", token.code);
      expiration = SIGNIN_EXPIRATION;
      for (const { email } of account.emails) {
        await sendEmail({
          to: email,
          subject: t("signInUp.signInEmailSubject"),
          text: t("signInUp.signInEmailText", {
            verifyUrl: verifyUrl.href,
            code: token.code,
            expiration: expiration.toLocaleString(ctx.state.language, {
              // @ts-ignore: DurationFormatOptions, not DateTimeFormatOptions
              style: "long",
            }),
          }),
        });
      }
      signInToken = token.token;
    }
    return page<SignPageProps>({
      success: true,
      email,
      expiration,
      token: signInToken,
    });
  },
});

type SignPageProps =
  | { success?: undefined }
  | { success: false } & Omit<SignFormProps, "language">
  | {
    success: true;
    email: string;
    expiration: Temporal.Duration;
    token: string;
  };

export default define.page<typeof handler, SignPageProps>(
  function SignPage({ data, state }) {
    const t = getFixedT(state.language);
    return (
      <div>
        <PageTitle>
          <Msg $key="signInUp.title" />
        </PageTitle>
        {data?.success == null
          ? <SignForm language={state.language} />
          : data?.success === false
          ? (
            <SignForm
              language={state.language}
              values={data?.values}
              errors={data?.errors}
            />
          )
          : (
            <div class="prose dark:prose-invert">
              <p>
                {isEmail(data.email)
                  ? (
                    <Msg
                      $key="signInUp.emailSentDescription"
                      email={<strong>{data.email}</strong>}
                    />
                  )
                  : (
                    <Msg
                      $key="signInUp.emailSentToUsernameDescription"
                      username={<strong>{data.email}</strong>}
                    />
                  )}
              </p>
              <form
                action={`sign/in/${data.token}`}
                method="post"
              >
                <div class="flex flex-col gap-2">
                  <Label label={t("signInUp.code")} required>
                    <Input
                      type="text"
                      name="code"
                      class="w-full"
                    />
                  </Label>
                  <Button class="w-full mt-4" type="submit">
                    <Msg $key="signInUp.submit" />
                  </Button>
                </div>
              </form>
              <p>
                <Msg
                  $key="signInUp.emailSentExpires"
                  expiration={data.expiration.toLocaleString(state.language, {
                    // @ts-ignore: DurationFormatOptions, not DateTimeFormatOptions
                    style: "long",
                  })}
                />
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
