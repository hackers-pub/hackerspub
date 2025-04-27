import { getAuthenticationOptions } from "@hackerspub/models/passkey";
import { validateUuid } from "@hackerspub/models/uuid";
import { kv } from "../../kv.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const sessionId = ctx.url.searchParams.get("sessionId")?.trim();
  if (!validateUuid(sessionId)) return ctx.next();
  const options = await getAuthenticationOptions(
    kv,
    ctx.state.fedCtx.canonicalOrigin,
    sessionId,
  );
  return new Response(
    JSON.stringify(options),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
});
