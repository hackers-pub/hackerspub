import { accountTable, invitationLinkTable } from "@hackerspub/models/schema";
import { validateUuid } from "@hackerspub/models/uuid";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../../db.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (ctx.state.account?.username !== ctx.params.username) return ctx.next();
    const { id } = ctx.params;
    if (!validateUuid(id)) return ctx.next();
    const { account } = ctx.state;
    await db.transaction(async (tx) => {
      const deleted = await tx.delete(invitationLinkTable)
        .where(and(
          eq(invitationLinkTable.inviterId, account.id),
          eq(invitationLinkTable.id, id),
        ))
        .returning();
      if (deleted.length < 1) return;
      await tx.update(accountTable)
        .set({
          leftInvitations: sql`${accountTable.leftInvitations} + ${
            deleted[0].invitationsLeft
          }`,
        })
        .where(eq(accountTable.id, account.id));
    });
    return ctx.redirect(`/@${account.username}/settings/invite`);
  },
});
