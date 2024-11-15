import { eq } from "drizzle-orm";
import { db } from "../../../../db.ts";
import { define } from "../../../../utils.ts";
import { accountTable } from "../../../../models/schema.ts";
import { deleteArticleDraft } from "../../../../models/article.ts";
import { validateUuid } from "../../../../models/uuid.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (!validateUuid(ctx.params.draftId)) return ctx.next();
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
    });
    if (account?.id !== ctx.state.session.accountId) return ctx.next();
    const draft = await deleteArticleDraft(db, account.id, ctx.params.draftId);
    if (draft == null) return ctx.next();
    return ctx.redirect(`/@${account.username}/drafts`);
  },
});
