import * as v from "@valibot/valibot";
import { sql } from "drizzle-orm";
import { page } from "fresh";
import { Msg } from "../../../components/Msg.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { db } from "../../../db.ts";
import { drive } from "../../../drive.ts";
import { Composer } from "../../../islands/Composer.tsx";
import {
  PostControls,
  toReactionStates,
} from "../../../islands/PostControls.tsx";
import { kv } from "../../../kv.ts";
import { createNote, getNoteSource } from "../../../models/note.ts";
import {
  getPostByUsernameAndId,
  isPostVisibleTo,
} from "../../../models/post.ts";
import type {
  Actor,
  Following,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";
import { NoteSourceSchema } from "../index.tsx";

type EnrichedPost = Post & {
  actor: Actor & { instance: Instance; followers: Following[] };
  link: PostLink & { creator?: Actor | null } | null;
  sharedPost:
    | Post & {
      actor: Actor & { instance: Instance };
      link: PostLink & { creator?: Actor | null } | null;
      replyTarget:
        | Post & {
          actor: Actor & { instance: Instance; followers: Following[] };
          link: PostLink & { creator?: Actor | null } | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
        }
        | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
      reactions: Reaction[];
    }
    | null;
  replyTarget:
    | Post & {
      actor: Actor & { instance: Instance; followers: Following[] };
      link: PostLink & { creator?: Actor | null } | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
    }
    | null;
  mentions: (Mention & { actor: Actor })[];
  media: PostMedium[];
  shares: Post[];
  reactions: Reaction[];
};

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    let post: EnrichedPost;
    if (ctx.params.username.includes("@")) {
      const result = await getPostByUsernameAndId(
        db,
        ctx.params.username,
        id,
        ctx.state.account,
      );
      if (result == null) return ctx.next();
      post = result;
    } else {
      const note = await getNoteSource(
        db,
        ctx.params.username,
        id,
        ctx.state.account,
      );
      if (note == null) return ctx.next();
      post = note.post;
    }
    if (!isPostVisibleTo(post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const quotes = await db.query.postTable.findMany({
      with: {
        actor: { with: { instance: true } },
        link: {
          with: { creator: true },
        },
        mentions: {
          with: { actor: true },
        },
        media: true,
        shares: {
          where: ctx.state.account == null
            ? { RAW: sql`false` }
            : { actorId: ctx.state.account.actor.id },
        },
        reactions: {
          where: ctx.state.account == null
            ? { RAW: sql`false` }
            : { actorId: ctx.state.account.actor.id },
        },
      },
      where: {
        quotedPostId: post.id,
        sharedPostId: { isNull: true },
      },
      orderBy: { published: "desc" },
    });
    return page<NoteQuotesProps>({
      post,
      quotes,
    });
  },

  async POST(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    let post: EnrichedPost;
    if (ctx.params.username.includes("@")) {
      const result = await getPostByUsernameAndId(
        db,
        ctx.params.username,
        id,
        ctx.state.account,
      );
      if (result == null) return ctx.next();
      post = result;
    } else {
      const note = await getNoteSource(
        db,
        ctx.params.username,
        id,
        ctx.state.account,
      );
      if (note == null) return ctx.next();
      post = note.post;
    }
    if (!isPostVisibleTo(post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    if (ctx.state.account == null) {
      return new Response("Forbidden", { status: 403 });
    }
    const payload = await ctx.req.json();
    const parsed = await v.safeParseAsync(NoteSourceSchema, payload);
    if (!parsed.success) {
      return new Response(JSON.stringify(parsed.issues), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const disk = drive.use();
    const quote = await createNote(db, kv, disk, ctx.state.fedCtx, {
      ...parsed.output,
      accountId: ctx.state.account.id,
    }, { quotedPost: post });
    if (quote == null) {
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response(JSON.stringify(quote), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  },
});

interface NoteQuotesProps {
  post: EnrichedPost;
  quotes: (
    Post & {
      actor: Actor & { instance: Instance };
      link: PostLink & { creator?: Actor | null } | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
      reactions: Reaction[];
    }
  )[];
}

export default define.page<typeof handler, NoteQuotesProps>(
  function NoteQuotes(
    { data: { post, quotes }, state },
  ) {
    const postUrl = post.noteSourceId == null
      ? `/${post.actor.handle}/${post.id}`
      : `/@${post.actor.username}/${post.noteSourceId}`;
    return (
      <>
        <PostExcerpt
          post={post}
          noControls
          signedAccount={state.account}
        />
        <PostControls
          class="mt-4 ml-14"
          language={state.language}
          visibility={post.visibility}
          active="quote"
          replies={post.repliesCount}
          replyUrl={`${postUrl}#replies`}
          shares={post.sharesCount}
          shareUrl={state.account == null ||
              !["public", "unlisted"].includes(post.visibility)
            ? undefined
            : `${postUrl}/share`}
          unshareUrl={state.account == null ||
              !["public", "unlisted"].includes(post.visibility)
            ? undefined
            : `${postUrl}/unshare`}
          shared={post.shares.some((share) =>
            share.actorId === state.account?.actor.id
          )}
          quoteUrl=""
          quotesCount={quotes.length}
          reactUrl={state.account == null ? undefined : `${postUrl}/react`}
          reactionStates={toReactionStates(state.account, post.reactions)}
          reactionsCounts={post.reactionsCounts}
          reactionsUrl={`${postUrl}/reactions`}
          deleteUrl={state.account == null ||
              state.account.actor.id !== post.actorId
            ? undefined
            : postUrl}
        />
        <div class="mt-8">
          {state.account == null
            ? (
              <>
                <hr class="my-4 ml-14 opacity-50 dark:opacity-25" />
                <p class="mt-4 leading-7 ml-14 text-stone-500 dark:text-stone-400">
                  <Msg
                    $key="note.remoteQuoteDescription"
                    permalink={
                      <span class="font-bold border-dashed border-b-[1px] select-all text-stone-950 dark:text-stone-50">
                        {post.iri}
                      </span>
                    }
                  />
                </p>
              </>
            )
            : (
              <Composer
                language={state.language}
                postUrl=""
                noQuoteOnPaste
                onPost="post.url"
              />
            )}
          {quotes.map((quote) => (
            <PostExcerpt
              key={quote.id}
              post={{ ...quote, sharedPost: null, replyTarget: null }}
              noQuote
            />
          ))}
        </div>
      </>
    );
  },
);
