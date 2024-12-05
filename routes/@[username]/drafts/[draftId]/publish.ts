import * as v from "@valibot/valibot";
import { and, eq } from "drizzle-orm";
import { define } from "../../../../utils.ts";
import { db } from "../../../../db.ts";
import { kv } from "../../../../kv.ts";
import { articleDraftTable } from "../../../../models/schema.ts";
import { validateUuid } from "../../../../models/uuid.ts";
import {
  createArticle,
  deleteArticleDraft,
} from "../../../../models/article.ts";

const ArticleSourceSchema = v.object({
  slug: v.pipe(v.string(), v.trim(), v.maxLength(128)),
  language: v.pipe(v.string(), v.trim(), v.maxLength(2)),
});

export const handler = define.handlers({
  async POST(ctx) {
    if (!validateUuid(ctx.params.draftId)) return ctx.next();
    if (ctx.state.session == null) return ctx.next();
    const draft = await db.query.articleDraftTable.findFirst({
      with: {
        account: true,
      },
      where: and(
        eq(articleDraftTable.id, ctx.params.draftId),
        eq(articleDraftTable.accountId, ctx.state.session.accountId),
      ),
    });
    if (draft == null || draft.account.username !== ctx.params.username) {
      return ctx.next();
    }
    const result = v.safeParse(ArticleSourceSchema, await ctx.req.json());
    if (!result.success) {
      return new Response(
        JSON.stringify(result.issues),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const post = await createArticle(db, kv, ctx.state.fedCtx, {
      accountId: ctx.state.session.accountId,
      title: draft.title,
      content: draft.content,
      tags: draft.tags,
      slug: result.output.slug,
      language: result.output.language,
    });
    if (post == null) {
      return new Response(
        JSON.stringify({ error: "Conflict error" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    await deleteArticleDraft(db, draft.account.id, draft.id);
    return new Response(
      JSON.stringify({ id: post.articleSourceId }),
      {
        status: 201,
        headers: {
          "Access-Control-Expose-Headers": "Location",
          "Content-Type": "application/json",
          Location: post.url!,
        },
      },
    );
  },
});
