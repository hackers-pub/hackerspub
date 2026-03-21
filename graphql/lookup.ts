import { isPostObject, persistPost } from "@hackerspub/models/post";
import type { Post } from "@hackerspub/models/schema";
import type { UserContext } from "./builder.ts";

/**
 * Parse and validate a URL string, returning a normalised `URL` only when the
 * scheme is `http:` or `https:`.  Returns `null` for anything else.
 */
export function parseHttpUrl(raw: string): URL | null {
  if (!URL.canParse(raw)) return null;
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed;
}

/**
 * Look up a post by URL. Checks the local database first (excluding share
 * rows), then attempts federation lookup if not found locally.  Returns
 * the original post row (without extra relations) or `null`.
 */
export async function lookupPostByUrl(
  ctx: UserContext,
  url: string,
): Promise<Post | null> {
  const parsed = parseHttpUrl(url);
  if (parsed == null) return null;
  url = parsed.href;

  const existing = await ctx.db.query.postTable.findFirst({
    where: {
      OR: [{ iri: url }, { url }],
      sharedPostId: { isNull: true },
    },
  });
  if (existing != null) return existing;

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
