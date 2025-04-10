import { db } from "../../../db.ts";
import { kv } from "../../../kv.ts";
import { getNoteSource } from "../../../models/note.ts";
import {
  getPostByUsernameAndId,
  isPostVisibleTo,
  unsharePost,
} from "../../../models/post.ts";
import type {
  Actor,
  Blocking,
  Following,
  Mention,
  Post,
} from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    let post: Post & {
      actor: Actor & {
        followers: Following[];
        blockees: Blocking[];
        blockers: Blocking[];
      };
      replyTarget: Post & { actor: Actor } | null;
      mentions: Mention[];
    };
    if (ctx.params.username.includes("@")) {
      if (ctx.params.username.endsWith(`@${ctx.url.host}`)) {
        return ctx.redirect(`/@${ctx.params.username}/${id}`);
      }
      const result = await getPostByUsernameAndId(db, ctx.params.username, id);
      if (result == null) return ctx.next();
      post = result;
    } else {
      const note = await getNoteSource(db, ctx.params.username, id);
      if (note == null) return ctx.next();
      post = note.post;
    }
    if (!isPostVisibleTo(post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    if (ctx.state.account == null) {
      return new Response("Forbidden", { status: 403 });
    }
    const unshared = await unsharePost(
      db,
      kv,
      ctx.state.fedCtx,
      ctx.state.account,
      post,
    );
    if (unshared == null) return ctx.next();
    return ctx.redirect(
      post.actor.accountId == null
        ? `/${post.actor.handle}/${post.id}`
        : `/@${post.actor.username}/${post.noteSourceId}`,
      303,
    );
  },
});
