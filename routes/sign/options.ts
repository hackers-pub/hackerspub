import { kv } from "../../kv.ts";
import { getAuthenticationOptions } from "../../models/passkey.ts";
import { validateUuid } from "../../models/uuid.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const sessionId = ctx.url.searchParams.get("sessionId")?.trim();
  if (!validateUuid(sessionId)) return ctx.next();
  const options = await getAuthenticationOptions(kv, sessionId);
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
