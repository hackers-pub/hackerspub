import { getRegistrationOptions } from "@hackerspub/models/passkey";
import { db } from "../../../../db.ts";
import { kv } from "../../../../kv.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const account = await db.query.accountTable.findFirst({
    with: { passkeys: true },
    where: { username: ctx.params.username },
  });
  if (account == null) return ctx.next();
  if (account.id !== ctx.state.account?.id) return ctx.next();
  const options = await getRegistrationOptions(
    kv,
    ctx.state.fedCtx.canonicalOrigin,
    account,
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
