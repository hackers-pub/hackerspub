import {
  isPostObject,
  isPostVisibleTo,
  persistPost,
} from "@hackerspub/models/post";
import type {
  Account,
  Actor,
  Blocking,
  Following,
  Mention,
  Poll,
  PollOption,
  PollVote,
  Post,
} from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { sql } from "drizzle-orm";
import { db } from "../../../../db.ts";
import { define } from "../../../../utils.ts";

export function getPost(
  id: Uuid,
  account?: Account & { actor: Actor },
): Promise<
  Post & {
    actor: Actor & {
      followers: Following[];
      blockees: Blocking[];
      blockers: Blocking[];
    };
    mentions: Mention[];
    poll:
      | Poll & {
        options: PollOption[];
        votes: PollVote[];
      }
      | null;
  } | undefined
> {
  return db.query.postTable.findFirst({
    where: { id },
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
      mentions: true,
      poll: {
        with: {
          options: {
            orderBy: { index: "asc" },
          },
          votes: {
            where: {
              actorId: account?.actor.id,
            },
          },
        },
      },
    },
  });
}

export const handler = define.handlers(async (ctx) => {
  if (!validateUuid(ctx.params.id)) return ctx.next();
  let post = await getPost(ctx.params.id, ctx.state.account);
  if (post == null || post.type !== "Question") return ctx.next();
  if (!isPostVisibleTo(post, ctx.state.account?.actor)) return ctx.next();
  if (post.poll == null) {
    const documentLoader = ctx.state.account == null
      ? undefined
      : await ctx.state.fedCtx.getDocumentLoader({
        identifier: ctx.state.account.id,
      });
    const postObject = await ctx.state.fedCtx.lookupObject(post.iri, {
      documentLoader,
    });
    if (!isPostObject(postObject)) return ctx.next();
    await persistPost(ctx.state.fedCtx, postObject);
    post = await getPost(post.id, ctx.state.account);
    if (post?.poll == null) return ctx.next();
  }
  return new Response(
    JSON.stringify(post.poll),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
});
