import { passkeyTable } from "@hackerspub/models/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (ctx.state.account?.username !== ctx.params.username) return ctx.next();
    const form = await ctx.req.formData();
    const id = form.get("id")?.toString();
    if (id == null) return ctx.next();
    await db.delete(passkeyTable).where(
      and(
        eq(passkeyTable.accountId, ctx.state.account.id),
        eq(passkeyTable.id, id),
      ),
    );
    return ctx.redirect(`/@${ctx.params.username}/settings/passkeys`);
  },
});
