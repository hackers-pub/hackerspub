import { page } from "@fresh/core";
import { getAvatarUrl, normalizeEmail } from "@hackerspub/models/account";
import { preprocessContentHtml } from "@hackerspub/models/html";
import { renderMarkup } from "@hackerspub/models/markup";
import {
  type Account,
  type AccountEmail,
  type InvitationLink,
  invitationLinkTable,
} from "@hackerspub/models/schema";
import { createSignupToken } from "@hackerspub/models/signup";
import { validateUuid } from "@hackerspub/models/uuid";
import { eq, sql } from "drizzle-orm";
import { Button } from "../../../../components/Button.tsx";
import { Input } from "../../../../components/Input.tsx";
import { Label } from "../../../../components/Label.tsx";
import { Msg } from "../../../../components/Msg.tsx";
import { PageTitle } from "../../../../components/PageTitle.tsx";
import { db } from "../../../../db.ts";
import { drive } from "../../../../drive.ts";
import { sendEmail } from "../../../../email.ts";
import { Timestamp } from "../../../../islands/Timestamp.tsx";
import { kv } from "../../../../kv.ts";
import { define } from "../../../../utils.ts";
import { EXPIRATION } from "../../settings/invite.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    const { id } = ctx.params;
    if (!validateUuid(id)) return ctx.next();
    const invitationLink = await db.query.invitationLinkTable.findFirst({
      with: { inviter: { with: { emails: true } } },
      where: { id },
    });
    if (invitationLink == null) return ctx.next();
    else if (invitationLink.inviter.username !== ctx.params.username) {
      return ctx.next();
    }
    return page<InvitationLinkPageProps>({
      inviter: invitationLink.inviter,
      invitationLink,
    });
  },

  async POST(ctx) {
    const { id } = ctx.params;
    if (!validateUuid(id)) return ctx.next();
    const invitationLink = await db.query.invitationLinkTable.findFirst({
      with: { inviter: { with: { emails: true } } },
      where: { id },
    });
    if (invitationLink == null) return ctx.next();
    else if (
      invitationLink.expires && invitationLink.expires < new Date() ||
      invitationLink.invitationsLeft < 1
    ) {
      return page<InvitationLinkPageProps>({
        inviter: invitationLink.inviter,
        invitationLink,
      });
    }
    const form = await ctx.req.formData();
    const email = normalizeEmail(form.get("email")?.toString()?.trim());
    if (email == null || email === "") return ctx.next();
    const { t } = ctx.state;
    return await db.transaction(async (tx) => {
      const existing = await tx.query.accountEmailTable.findFirst({
        where: { email },
      });
      if (existing != null) {
        return page<InvitationLinkPageProps>({
          inviter: invitationLink.inviter,
          invitationLink,
          result: { duplicateEmail: email },
        });
      }
      const updated = await tx.update(invitationLinkTable)
        .set({
          invitationsLeft: sql`${invitationLinkTable.invitationsLeft} - 1`,
        })
        .where(eq(invitationLinkTable.id, invitationLink.id))
        .returning();
      if (updated.length < 1) return ctx.next();
      else if (updated[0].invitationsLeft < 0) tx.rollback();
      const token = await createSignupToken(kv, email, {
        inviterId: invitationLink.inviter.id,
        expiration: EXPIRATION,
      });
      const verifyUrl = new URL(
        `/sign/up/${token.token}`,
        ctx.state.canonicalOrigin,
      );
      verifyUrl.searchParams.set("code", token.code);
      const inviter =
        `${invitationLink.inviter.name} (@${invitationLink.inviter.username}@${
          new URL(ctx.state.canonicalOrigin).host
        })`;
      await sendEmail({
        to: email,
        subject: t("settings.invite.invitationEmailSubject", {
          inviter,
          inviterName: invitationLink.inviter.name,
        }),
        text: t("settings.invite.invitationEmailText", {
          inviter,
          inviterName: invitationLink.inviter.name,
          verifyUrl: verifyUrl.href,
          expiration: EXPIRATION.toLocaleString(ctx.state.language, {
            // @ts-ignore: DurationFormatOptions, not DateTimeFormatOptions
            style: "long",
          }),
        }),
      });
      return page<InvitationLinkPageProps>({
        inviter: invitationLink.inviter,
        invitationLink,
        result: { sentEmail: email },
      });
    });
  },
});

interface InvitationLinkPageProps {
  inviter: Account & { emails: AccountEmail[] };
  invitationLink: InvitationLink;
  result?:
    | { duplicateEmail: string }
    | { sentEmail: string };
}

export default define.page<typeof handler, InvitationLinkPageProps>(
  async function InvitationLinkPage(
    {
      url,
      state: { fedCtx, t, language },
      data: { inviter, invitationLink, result },
    },
  ) {
    if (result != null && "sentEmail" in result) {
      return (
        <h1 class="mt-4">
          <Msg
            $key="invitationLink.sent"
            email={<strong>{result.sentEmail}</strong>}
          />
        </h1>
      );
    } else if (invitationLink.expires && invitationLink.expires < new Date()) {
      return (
        <h1 class="mt-4">
          <Msg $key="invitationLink.expired" />
        </h1>
      );
    } else if (invitationLink.invitationsLeft < 1) {
      return (
        <h1 class="mt-4">
          <Msg $key="invitationLink.exhausted" />
        </h1>
      );
    }
    const disk = drive.use();
    const inviterAvatarUrl = await getAvatarUrl(disk, inviter);
    const message = invitationLink.message == null
      ? null
      : await renderMarkup(fedCtx, invitationLink.message, {
        kv,
        docId: invitationLink.id,
      });
    const inviterComponent = (
      <a href={`/@${inviter.username}`}>
        <img
          src={inviterAvatarUrl}
          alt=""
          class="size-6 inline-block align-top"
        />{" "}
        <strong>{inviter.name}</strong>{" "}
        <span class="text-stone-500 dark:text-stone-400">
          (@{inviter.username}@{url.host})
        </span>
      </a>
    );
    return (
      <div class="mt-4">
        <h1>
          <Msg
            $key="invitationLink.description"
            inviter={inviterComponent}
          />
        </h1>
        <div class="mt-4 border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-4">
          <PageTitle>
            <Msg $key="invitationLink.introTitle" />
          </PageTitle>
          <p>
            <Msg $key="invitationLink.introContent" />
          </p>
        </div>
        {message && (
          <div class="my-8">
            <p>
              <Msg
                $key="invitationLink.messageDescription"
                inviter={inviterComponent}
              />
            </p>
            <blockquote
              class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-4 prose dark:prose-invert prose-blockquote: w-full max-w-none mt-4"
              dangerouslySetInnerHTML={{
                __html: preprocessContentHtml(
                  message.html,
                  {
                    mentions: Object.values(
                      message.mentions,
                    ).map((actor) => ({ actor })),
                    tags: {},
                  },
                ),
              }}
            />
          </div>
        )}
        <ul>
          <li class="list-disc list-inside">
            <Msg
              $key="invitationLink.invitationsLeft"
              count={invitationLink.invitationsLeft}
            />
          </li>
          {invitationLink.expires && (
            <li class="list-disc list-inside">
              <Msg
                $key="invitationLink.expiration"
                expiration={
                  <Timestamp
                    value={invitationLink.expires}
                    locale={language}
                    allowFuture
                  />
                }
              />
            </li>
          )}
        </ul>
        <form method="post" class="mt-8">
          <div>
            <Label label={t("invitationLink.email")} required>
              <Input
                type="email"
                name="email"
                value={result != null && "duplicateEmail" in result
                  ? result.duplicateEmail
                  : undefined}
                required
              />
            </Label>
            {result != null && "duplicateEmail" in result
              ? (
                <p class="text-red-600 dark:text-red-400">
                  <Msg $key="invitationLink.duplicateEmail" />
                </p>
              )
              : (
                <p class="opacity-50">
                  <Msg $key="invitationLink.emailDescription" />
                </p>
              )}
          </div>
          <div class="mt-4">
            <Button type="submit">
              <Msg $key="invitationLink.signUp" />
            </Button>
          </div>
        </form>
      </div>
    );
  },
);
