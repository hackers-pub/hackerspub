import { db } from "../../../db.ts";
import { isReactionEmoji } from "../../../models/emoji.ts";
import { getNoteSource } from "../../../models/note.ts";
import {
  getPostByUsernameAndId,
  isPostVisibleTo,
} from "../../../models/post.ts";
import { react, undoReaction } from "../../../models/reaction.ts";
import type {
  Actor,
  Following,
  Mention,
  Post,
  Reaction,
} from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    let post: Post & {
      actor: Actor & { followers: Following[] };
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
    const { emoji, mode } = await ctx.req.json();
    if (!isReactionEmoji(emoji)) {
      return new Response("Bad Request", { status: 400 });
    }
    let reaction: Reaction | undefined;
    if (mode === "undo") {
      reaction = await undoReaction(
        db,
        ctx.state.fedCtx,
        ctx.state.account,
        post,
        emoji,
      );
    } else {
      reaction = await react(
        db,
        ctx.state.fedCtx,
        ctx.state.account,
        post,
        emoji,
      );
    }
    if (reaction == null) return new Response("Bad Request", { status: 400 });
    return new Response(JSON.stringify(reaction), {
      headers: {
        "Content-Type": "application/json",
      },
    });
  },
});
