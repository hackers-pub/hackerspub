import { page } from "@fresh/core";
import { syncActorFromAccount } from "@hackerspub/models/actor";
import { createSession, EXPIRATION } from "@hackerspub/models/session";
import { getSigninToken } from "@hackerspub/models/signin";
import { validateUuid } from "@hackerspub/models/uuid";
import { setCookie } from "@std/http/cookie";
import { PageTitle } from "../../../components/PageTitle.tsx";
import { db } from "../../../db.ts";
import { kv } from "../../../kv.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers(
  async function handleSigninRequest(ctx) {
    if (!validateUuid(ctx.params.token)) return ctx.next();
    const token = await getSigninToken(kv, ctx.params.token);
    if (token == null) return ctx.next();
    let code: string | null = null;
    if (ctx.req.method === "GET") {
      code = ctx.url.searchParams.get("code");
    } else if (ctx.req.method === "POST") {
      const form = await ctx.req.formData();
      const form_code = form.get("code");
      if (typeof form_code !== "string") {
        return new Response("code should be string", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        });
      }
      code = form_code;
    } else {
      return new Response("Not supported method", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (code !== token.code) return page();
    const account = await db.query.accountTable.findFirst({
      where: { id: token.accountId },
      with: {
        emails: true,
        links: { orderBy: { index: "asc" } },
      },
    });
    if (account == null) return page();
    await syncActorFromAccount(ctx.state.fedCtx, account);
    const session = await createSession(kv, {
      accountId: token.accountId,
      ipAddress: ctx.info.remoteAddr.transport === "tcp"
        ? ctx.info.remoteAddr.hostname
        : undefined,
      userAgent: ctx.req.headers.get("user-agent"),
    });
    const headers = new Headers();
    setCookie(headers, {
      name: "session",
      value: session.id,
      path: "/",
      expires: new Date(Temporal.Now.instant().add(EXPIRATION).toString()),
      secure: ctx.url.protocol === "https:",
    });
    const from = ctx.url.searchParams.get("from") || "/";
    headers.set("Location", from);
    return new Response(null, { status: 303, headers });
  },
);

export default define.page<typeof handler>(function SigninPage() {
  return (
    <div>
      <PageTitle>Sign in</PageTitle>
      <p>
        The sign-in link is invalid or expired. Please make sure you're using
        the correct link from the email you received.
      </p>
    </div>
  );
});
