import { setCookie } from "@std/http/cookie";
import { eq } from "drizzle-orm";
import { page } from "fresh";
import { PageTitle } from "../../../components/PageTitle.tsx";
import { createSession, EXPIRATION } from "../../../models/session.ts";
import { getSigninToken } from "../../../models/signin.ts";
import { db } from "../../../db.ts";
import { kv } from "../../../kv.ts";
import { define } from "../../../utils.ts";
import { accountLinkTable, accountTable } from "../../../models/schema.ts";
import { syncActorFromAccount } from "../../../models/actor.ts";
import { validateUuid } from "../../../models/uuid.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.token)) return ctx.next();
    const token = await getSigninToken(kv, ctx.params.token);
    if (token == null) return ctx.next();
    const code = ctx.url.searchParams.get("code");
    if (code !== token.code) return page();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.id, token.accountId),
      with: {
        links: { orderBy: accountLinkTable.index },
      },
    });
    if (account == null) return page();
    await syncActorFromAccount(db, kv, ctx.state.fedCtx, account);
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
    headers.set("Location", "/");
    return new Response(null, { status: 301, headers });
  },
});

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
