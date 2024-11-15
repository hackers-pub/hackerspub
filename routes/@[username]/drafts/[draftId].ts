import * as v from "@valibot/valibot";
import { eq } from "drizzle-orm";
import { db } from "../../../db.ts";
import { updateArticleDraft } from "../../../models/article.ts";
import { define } from "../../../utils.ts";
import { accountTable } from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";

const TagSchema = v.pipe(v.string(), v.regex(/^[^\s,]+$/));

const ArticleDraftSchema = v.object({
  title: v.pipe(v.optional(v.string(), ""), v.trim()),
  content: v.optional(v.string(), ""),
  tags: v.optional(v.array(TagSchema), []),
});

export const handler = define.handlers({
  async PUT(ctx) {
    if (!validateUuid(ctx.params.draftId)) return ctx.next();
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
    });
    if (account?.id !== ctx.state.session.accountId) return ctx.next();
    const data = await ctx.req.json();
    const result = v.safeParse(ArticleDraftSchema, data);
    if (!result.success) {
      return new Response(
        JSON.stringify(result.issues),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const draft = await updateArticleDraft(db, {
      ...result.output,
      id: ctx.params.draftId,
      accountId: ctx.state.session.accountId,
    });
    return new Response(
      JSON.stringify(draft),
      { headers: { "Content-Type": "application/json" } },
    );
  },
});
