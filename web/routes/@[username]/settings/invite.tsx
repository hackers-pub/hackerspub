import { type FreshContext, page } from "@fresh/core";
import { getAvatarUrl } from "@hackerspub/models/avatar";
import { type Account, accountTable } from "@hackerspub/models/schema";
import { createSignupToken } from "@hackerspub/models/signup";
import { eq, sql } from "drizzle-orm";
import { Msg } from "../../../components/Msg.tsx";
import { PageTitle } from "../../../components/PageTitle.tsx";
import { SettingsNav } from "../../../components/SettingsNav.tsx";
import { db } from "../../../db.ts";
import { sendEmail } from "../../../email.ts";
import getFixedT, { isLanguage } from "../../../i18n.ts";
import {
  type AccountWithInvitationInfo,
  InviteForm,
  type InviteFormProps,
} from "../../../islands/InviteForm.tsx";
import { kv } from "../../../kv.ts";
import { define, type State } from "../../../utils.ts";

export const EXPIRATION = Temporal.Duration.from({ hours: 48 });

type InvitePageProps = Omit<InviteFormProps, "language">;

async function sendInvitation(
  ctx: FreshContext<State>,
  account: AccountWithInvitationInfo & Pick<Account, "id">,
): Promise<InvitePageProps> {
  const canonicalHost = new URL(ctx.state.canonicalOrigin).host;
  if (account.leftInvitations < 1) {
    return {
      success: false,
      account,
      error: "noLeftInvitations",
      canonicalHost,
    } as InvitePageProps;
  }
  const form = await ctx.req.formData();
  const email = form.get("email")?.toString()?.trim();
  let language = form.get("language")?.toString()?.trim();
  if (language == null || !isLanguage(language)) {
    language = ctx.state.language;
  }
  const message = form.get("message")?.toString()?.trim();
  if (email == null || email === "") {
    return {
      success: false,
      account,
      error: "emailRequired",
      canonicalHost,
    } as InvitePageProps;
  }
  const existingEmail = await db.query.accountEmailTable.findFirst({
    where: { email },
    with: { account: true },
  });
  if (existingEmail != null) {
    return {
      success: false,
      account,
      error: "alreadyExists",
      existingAccount: {
        username: existingEmail.account.username,
        name: existingEmail.account.name,
      },
      canonicalHost,
    } as InvitePageProps;
  }
  const token = await createSignupToken(kv, email, {
    inviterId: account.id,
    expiration: EXPIRATION,
  });
  const verifyUrl = new URL(
    `/sign/up/${token.token}`,
    ctx.state.canonicalOrigin,
  );
  verifyUrl.searchParams.set("code", token.code);
  const inviter = `${account.name} (@${account.username}@${
    new URL(ctx.state.canonicalOrigin).host
  })`;
  const t = getFixedT(language);
  await sendEmail({
    to: email,
    subject: t("settings.invite.invitationEmailSubject", {
      inviter,
      inviterName: account.name,
    }),
    text: message == null || message === ""
      ? t("settings.invite.invitationEmailText", {
        inviter,
        inviterName: account.name,
        verifyUrl: verifyUrl.href,
        expiration: EXPIRATION.toLocaleString(language, {
          // @ts-ignore: DurationFormatOptions, not DateTimeFormatOptions
          style: "long",
        }),
      })
      : t("settings.invite.invitationEmailTextWithMessage", {
        inviter,
        inviterName: account.name,
        message: `> ${message.replace(/\n/g, "\n> ")}`,
        verifyUrl: verifyUrl.href,
        expiration: EXPIRATION.toLocaleString(language, {
          // @ts-ignore: DurationFormatOptions, not DateTimeFormatOptions
          style: "long",
        }),
      }),
  });
  await db.update(accountTable).set({
    leftInvitations: sql`greatest(${accountTable.leftInvitations} - 1, 0)`,
  }).where(eq(accountTable.id, account.id));
  account.leftInvitations -= 1;
  return {
    success: true,
    account,
    email,
    canonicalHost,
  } as InvitePageProps;
}

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.account == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: { username: ctx.params.username },
      with: {
        inviter: {
          with: { actor: true },
        },
        invitees: {
          with: { actor: true },
          orderBy: { created: "desc" },
        },
      },
    });
    if (ctx.state.account.id !== account?.id) return ctx.next();
    return page<InvitePageProps>({
      account,
      canonicalHost: new URL(ctx.state.canonicalOrigin).host,
    });
  },

  async POST(ctx) {
    if (ctx.state.account == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: { username: ctx.params.username },
      with: {
        inviter: {
          with: { actor: true },
        },
        invitees: {
          with: { actor: true },
          orderBy: { created: "desc" },
        },
      },
    });
    if (ctx.state.account.id !== account?.id) return ctx.next();

    const result = await sendInvitation(ctx, account);
    if (ctx.req.headers.get("Accept") === "application/json") {
      const { account, ...response } = result;
      return new Response(
        JSON.stringify({
          language: ctx.state.language,
          account: {
            leftInvitations: account.leftInvitations,
            username: account.username,
            name: account.name,
            inviter: account.inviter && {
              username: account.inviter.username,
              name: account.inviter.name,
              id: account.inviter.id,
              actor: {
                avatarUrl: account.inviter.actor.avatarUrl,
              },
            },
            invitees: account.invitees.map((invitee) => ({
              username: invitee.username,
              name: invitee.name,
              id: invitee.id,
              actor: {
                avatarUrl: invitee.actor.avatarUrl,
              },
            })),
          },
          ...response,
        } as InviteFormProps),
        {
          status: result.success ? 200 : 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    } else {
      return page<InvitePageProps>(result);
    }
  },
});

export default define.page<typeof handler, InvitePageProps>(
  function InvitePage({ state, data }) {
    const { account, canonicalHost } = data;
    const formData = {
      language: state.language,
      ...data,
    } as InviteFormProps;
    return (
      <>
        <SettingsNav
          active="invite"
          settingsHref={`/@${account.username}/settings`}
          leftInvitations={account.leftInvitations}
        />
        <InviteForm {...formData}></InviteForm>
        {account.inviter != null && (
          <>
            <PageTitle class="mt-8">
              <Msg $key="settings.invite.inviter" />
            </PageTitle>
            <p>
              <a href={`/@${account.inviter.username}`}>
                <img
                  src={getAvatarUrl(account.inviter.actor)}
                  width={16}
                  height={16}
                  class="inline-block mr-1"
                />
                <strong>{account.inviter.name}</strong>
                <span class="opacity-50 before:content-['('] after:content-[')'] ml-1">
                  @{account.inviter.username}@{"host"}
                </span>
              </a>
            </p>
          </>
        )}
        {account.invitees.length > 0 && (
          <>
            <PageTitle class="mt-8">
              <Msg $key="settings.invite.invitees" />
            </PageTitle>
            <ul>
              {account.invitees.map((invitee) => (
                <li key={invitee.id} class="mb-2">
                  <a href={`/@${invitee.username}`}>
                    <img
                      src={getAvatarUrl(invitee.actor)}
                      width={16}
                      height={16}
                      class="inline-block mr-1"
                    />
                    <strong>{invitee.name}</strong>
                    <span class="opacity-50 before:content-['('] after:content-[')'] ml-1">
                      @{invitee.username}@{canonicalHost}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
        <PageTitle class="mt-8">
          <Msg $key="settings.invite.tree" />
        </PageTitle>
        <p>
          <a href="/tree">
            <Msg $key="settings.invite.viewTree" />
          </a>
        </p>
      </>
    );
  },
);
