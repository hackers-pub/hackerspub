import type { RequestContext } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import { isActorSanctionHidden } from "@hackerspub/models/post/visibility";
import type { Actor, Post } from "@hackerspub/models/schema";
import { validateUuid } from "@hackerspub/models/uuid";

/**
 * Whether an `Accept` header admits `text/html`.  The most specific matching
 * range (`text/html`, then `text/*`, then `*\/*`) decides, and a missing or
 * empty header counts as `*\/*`.
 */
export function acceptsHtml(accept: string | null): boolean {
  if (accept == null || accept.trim() === "") return true;
  let specificity = -1;
  let quality = 0;
  for (const part of accept.split(",")) {
    const [mediaRange, ...parameters] = part.split(";");
    const [type, subtype] = mediaRange.trim().toLowerCase().split("/");
    const rangeSpecificity =
      type === "text" && subtype === "html"
        ? 2
        : type === "text" && subtype === "*"
          ? 1
          : type === "*" && subtype === "*"
            ? 0
            : -1;
    if (rangeSpecificity <= specificity) continue;
    let rangeQuality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.split("=");
      if (name.trim().toLowerCase() !== "q" || value == null) continue;
      const parsed = Number(value.trim());
      rangeQuality =
        Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    specificity = rangeSpecificity;
    quality = rangeQuality;
  }
  return quality > 0;
}

function notAcceptable(): Response {
  // Mirrors Fedify's default `onNotAcceptable` response.
  return new Response("Not Acceptable", {
    status: 406,
    headers: { Vary: "Accept, Signature" },
  });
}

function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      Vary: "Accept",
      // The same IRI serves ActivityPub JSON to other clients, so caches must
      // not hand this redirect to them.
      "Cache-Control": "private, no-store",
    },
  });
}

function getPostHtmlUrl(
  post: (Pick<Post, "censored" | "url"> & { actor: Actor }) | undefined,
): string | null {
  if (post == null || post.url == null) return null;
  // Content that is not served over ActivityPub is not redirected either.
  if (post.censored != null || isActorSanctionHidden(post.actor)) return null;
  return post.url;
}

async function getHtmlUrl(
  ctx: RequestContext<ContextData>,
  url: URL,
): Promise<string | null> {
  const parsed = ctx.parseUri(url);
  if (parsed?.type === "actor") {
    if (!validateUuid(parsed.identifier)) return null;
    const actor = await ctx.data.db.query.actorTable.findFirst({
      columns: { url: true },
      where: { accountId: parsed.identifier },
    });
    return actor?.url ?? null;
  }
  if (parsed?.type !== "object") return null;
  const id = parsed.values.id;
  if (id == null || !validateUuid(id)) return null;
  if (parsed.class === vocab.Note || parsed.class === vocab.Question) {
    const post = await ctx.data.db.query.postTable.findFirst({
      columns: { censored: true, url: true },
      with: { actor: true },
      where: {
        noteSourceId: id,
        type: parsed.class === vocab.Note ? "Note" : "Question",
      },
    });
    return getPostHtmlUrl(post);
  }
  if (parsed.class === vocab.Article) {
    const post = await ctx.data.db.query.postTable.findFirst({
      columns: { censored: true, url: true },
      with: { actor: true },
      where: { articleSourceId: id },
    });
    return getPostHtmlUrl(post);
  }
  return null;
}

/**
 * Fedify `onNotAcceptable` handler that sends browsers from a local actor,
 * note, question, or article IRI to its HTML permalink with
 * `303 See Other`, so that IRIs shown to people (e.g., in link cards made by
 * bridges) are not dead ends.  Every other request gets Fedify's default
 * `406 Not Acceptable`.
 *
 * Fedify calls this before the object dispatcher and its authorization
 * predicate, so this does its own lookup.  Non-public posts are redirected
 * too; the HTML permalink enforces visibility.
 */
export async function handleNotAcceptable(
  ctx: RequestContext<ContextData>,
  request: Request,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return notAcceptable();
  }
  if (!acceptsHtml(request.headers.get("Accept"))) return notAcceptable();
  const location = await getHtmlUrl(ctx, new URL(request.url));
  return location == null ? notAcceptable() : seeOther(location);
}
