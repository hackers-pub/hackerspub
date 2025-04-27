import { verifyAuthentication } from "@hackerspub/models/passkey";
import { createSession, EXPIRATION } from "@hackerspub/models/session";
import { validateUuid } from "@hackerspub/models/uuid";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { setCookie } from "@std/http/cookie";
import { db } from "../../db.ts";
import { kv } from "../../kv.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const sessionId = ctx.url.searchParams.get("sessionId");
    if (!validateUuid(sessionId)) return ctx.next();
    const authResponse: AuthenticationResponseJSON = await ctx.req.json();
    const result = await verifyAuthentication(
      db,
      kv,
      ctx.state.fedCtx.canonicalOrigin,
      sessionId,
      authResponse,
    );
    if (result == null) return new Response("null", { status: 404 });
    const { response, account } = result;
    const headers = new Headers();
    if (response.verified) {
      const session = await createSession(kv, {
        accountId: account.id,
        ipAddress: ctx.info.remoteAddr.transport === "tcp"
          ? ctx.info.remoteAddr.hostname
          : undefined,
        userAgent: ctx.req.headers.get("user-agent"),
      });
      setCookie(headers, {
        name: "session",
        value: session.id,
        path: "/",
        expires: new Date(Temporal.Now.instant().add(EXPIRATION).toString()),
        secure: ctx.url.protocol === "https:",
      });
    }
    headers.set("Content-Type", "application/json");
    return new Response(
      JSON.stringify(response),
      { headers },
    );
  },
});
