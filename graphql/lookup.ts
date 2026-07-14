import { isActor } from "@fedify/vocab";
import { persistActor } from "@hackerspub/models/actor";
import { isPostObject } from "@hackerspub/models/post/core";
import { persistPost } from "@hackerspub/models/post/remote";
import type { Actor, Post } from "@hackerspub/models/schema";
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
 * rows). Authenticated callers fall back to a federation lookup; guests
 * receive `null` after the local miss to avoid attacker-driven outbound
 * fetches and arbitrary remote-post persistence.  Returns the original
 * post row (without extra relations) or `null`.
 */
export async function lookupPostByUrl(
  ctx: UserContext,
  parsed: URL,
): Promise<Post | null> {
  const url = parsed.href;

  const existing = await ctx.db.query.postTable.findFirst({
    where: {
      OR: [{ iri: url }, { url }],
      sharedPostId: { isNull: true },
    },
  });
  if (existing != null) return existing;

  // Guests must not trigger federation lookups: they would let unauthenticated
  // callers spawn outbound fetches and persist arbitrary remote posts.
  if (ctx.account == null) return null;

  const documentLoader = await ctx.fedCtx.getDocumentLoader({
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

/**
 * Look up an actor by URL. Tries the local database first, matching the URL
 * against the actor's canonical `iri` and falling back to the human-facing
 * `url` (the latter is nullable and non-unique on the actor table, so the
 * `iri` match takes precedence). Authenticated callers fall back to a
 * federation lookup; guests receive `null` after the local miss to avoid
 * attacker-driven outbound fetches and arbitrary remote-actor persistence.
 * Returns the persisted actor row, or `null` when the URL doesn't resolve
 * to a fediverse actor.
 */
export async function lookupActorByUrl(
  ctx: UserContext,
  parsed: URL,
): Promise<Actor | null> {
  const url = parsed.href;

  const byIri = await ctx.db.query.actorTable.findFirst({
    where: { iri: url },
  });
  if (byIri != null) return byIri;

  const byUrl = await ctx.db.query.actorTable.findFirst({
    where: { url },
  });
  if (byUrl != null) return byUrl;

  // Guests must not trigger federation lookups: they would let unauthenticated
  // callers spawn outbound fetches and persist arbitrary remote actors.
  if (ctx.account == null) return null;

  const documentLoader = await ctx.fedCtx.getDocumentLoader({
    identifier: ctx.account.id,
  });

  let object;
  try {
    object = await ctx.fedCtx.lookupObject(url, { documentLoader });
  } catch {
    return null;
  }

  if (!isActor(object)) return null;

  return (await persistActor(ctx.fedCtx, object, { documentLoader })) ?? null;
}
