import { isPostObject, persistPost } from "@hackerspub/models/post";
import type { Post } from "@hackerspub/models/schema";
import type { UserContext } from "./builder.ts";

/**
 * Look up a post by URL. Checks the local database first, then attempts
 * federation lookup if not found locally.  If the matched row is a share,
 * dereferences to the original post.  Returns the raw post row
 * (without extra relations) or `null`.
 */
export async function lookupPostByUrl(
  ctx: UserContext,
  url: string,
): Promise<Post | null> {
  let existing = await ctx.db.query.postTable.findFirst({
    where: { OR: [{ iri: url }, { url }] },
  });
  if (existing != null) {
    if (existing.sharedPostId != null) {
      existing = await ctx.db.query.postTable.findFirst({
        where: { id: existing.sharedPostId },
      }) ?? null;
    }
    return existing;
  }

  const documentLoader = ctx.account == null
    ? ctx.fedCtx.documentLoader
    : await ctx.fedCtx.getDocumentLoader({
      identifier: ctx.account.id,
    });

  let object;
  try {
    object = await ctx.fedCtx.lookupObject(url, { documentLoader });
  } catch {
    return null;
  }

  if (!isPostObject(object)) return null;

  const persisted = await persistPost(ctx.fedCtx, object, {
    contextLoader: ctx.fedCtx.contextLoader,
    documentLoader,
  });

  return persisted ?? null;
}
