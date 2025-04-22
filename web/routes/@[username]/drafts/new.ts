import { generateUuidV7 } from "@hackerspub/models/uuid";
import { db } from "../../../db.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: { id: ctx.state.session.accountId },
    });
    if (account == null || account.username != ctx.params.username) {
      return ctx.next();
    }
    return ctx.redirect(`/@${account.username}/drafts/${generateUuidV7()}`);
  },
});
