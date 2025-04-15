import { sql } from "drizzle-orm";
import { db } from "../../../db.ts";
import { drive } from "../../../drive.ts";
import {
  isPostObject,
  isPostVisibleTo,
  persistPost,
} from "../../../models/post.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const iri = ctx.url.searchParams.get("iri");
  if (iri === null || !URL.canParse(iri) || !iri.match(/^https?:/)) {
    return ctx.next();
  }
  const { account, fedCtx } = ctx.state;
  let post = await db.query.postTable
    .findFirst({
      with: {
        actor: {
          with: {
            followers: {
              where: account == null
                ? { RAW: sql`false` }
                : { followerId: account.actor.id },
            },
            blockees: {
              where: account == null
                ? { RAW: sql`false` }
                : { blockeeId: account.actor.id },
            },
            blockers: {
              where: account == null
                ? { RAW: sql`false` }
                : { blockerId: account.actor.id },
            },
          },
        },
        mentions: { with: { actor: true } },
        sharedPost: {
          with: {
            actor: {
              with: {
                followers: {
                  where: account == null
                    ? { RAW: sql`false` }
                    : { followerId: account.actor.id },
                },
                blockees: {
                  where: account == null
                    ? { RAW: sql`false` }
                    : { blockeeId: account.actor.id },
                },
                blockers: {
                  where: account == null
                    ? { RAW: sql`false` }
                    : { blockerId: account.actor.id },
                },
              },
            },
            mentions: { with: { actor: true } },
          },
        },
      },
      where: { OR: [{ iri }, { url: iri }] },
    });
  if (post == null) {
    const documentLoader = account == null
      ? undefined
      : await fedCtx.getDocumentLoader({ identifier: account.id });
    const object = await fedCtx.lookupObject(iri, { documentLoader });
    if (!isPostObject(object)) return ctx.next();
    const disk = drive.use();
    const p = await persistPost(db, disk, fedCtx, object, { documentLoader });
    if (p == null) return ctx.next();
    const actor = await db.query.actorTable.findFirst({
      with: {
        followers: {
          where: account == null
            ? { RAW: sql`false` }
            : { followerId: account.actor.id },
        },
        blockees: {
          where: account == null
            ? { RAW: sql`false` }
            : { blockeeId: account.actor.id },
        },
        blockers: {
          where: account == null
            ? { RAW: sql`false` }
            : { blockerId: account.actor.id },
        },
      },
      where: { id: p.actorId },
    });
    if (actor == null) return ctx.next();
    post = { ...p, actor, sharedPost: null };
  } else if (post.sharedPost != null) {
    post = { ...post.sharedPost, sharedPost: null };
  }
  if (!isPostVisibleTo(post, account?.actor)) return ctx.next();
  return new Response(JSON.stringify(post), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
});
