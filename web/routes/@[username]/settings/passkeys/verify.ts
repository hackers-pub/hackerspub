import {
  resolvePasskeyOrigins,
  verifyRegistration,
} from "@hackerspub/models/passkey";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { db } from "../../../../db.ts";
import { kv } from "../../../../kv.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const account = await db.query.accountTable.findFirst({
      with: { passkeys: true },
      where: { username: ctx.params.username },
    });
    if (account == null) return ctx.next();
    if (account.id !== ctx.state.account?.id) return ctx.next();
    const registerResponse: {
      name: string;
      registrationResponse: RegistrationResponseJSON;
    } = await ctx.req.json();
    const serverOrigin = new URL(ctx.state.fedCtx.canonicalOrigin).origin;
    const origins = resolvePasskeyOrigins(serverOrigin, "web");
    const rpId = new URL(ctx.state.fedCtx.canonicalOrigin).hostname;
    const verifyResponse = await verifyRegistration(
      db,
      kv,
      origins,
      rpId,
      account,
      registerResponse.name,
      registerResponse.registrationResponse,
    );
    return new Response(
      JSON.stringify(verifyResponse),
      { headers: { "Content-Type": "application/json" } },
    );
  },
});
