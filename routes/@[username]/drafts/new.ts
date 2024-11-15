import { eq } from "drizzle-orm";
import { accountTable } from "../../../models/schema.ts";
import { generateUuidV7 } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";
import { db } from "../../../db.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.id, ctx.state.session.accountId),
    });
    if (account == null || account.username != ctx.params.username) {
      return ctx.next();
    }
    return ctx.redirect(`/@${account.username}/drafts/${generateUuidV7()}`);
  },
});
