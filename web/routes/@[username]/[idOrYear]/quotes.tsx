import { page } from "@fresh/core";
import { createNote, getNoteSource } from "@hackerspub/models/note";
import {
  getPostByUsernameAndId,
  isPostVisibleTo,
} from "@hackerspub/models/post";
import type {
  Actor,
  Blocking,
  Following,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "@hackerspub/models/schema";
import { withTransaction } from "@hackerspub/models/tx";
import { validateUuid } from "@hackerspub/models/uuid";
import * as v from "@valibot/valibot";
import { sql } from "drizzle-orm";
import { Msg } from "../../../components/Msg.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { db } from "../../../db.ts";
import { Composer } from "../../../islands/Composer.tsx";
import { PostControls } from "../../../islands/PostControls.tsx";
import { define } from "../../../utils.ts";
import { NoteSourceSchema } from "../index.tsx";

type EnrichedPost = Post & {
  actor: Actor & {
    instance: Instance;
    followers: Following[];
    blockees: Blocking[];
    blockers: Blocking[];
  };
  link: PostLink & { creator?: Actor | null } | null;
  sharedPost:
    | Post & {
      actor: Actor & {
        instance: Instance;
        followers: Following[];
        blockees: Blocking[];
        blockers: Blocking[];
      };
      link: PostLink & { creator?: Actor | null } | null;
      replyTarget:
        | Post & {
          actor: Actor & {
            instance: Instance;
            followers: Following[];
            blockees: Blocking[];
            blockers: Blocking[];
          };
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
      actor: Actor & {
        instance: Instance;
        followers: Following[];
        blockees: Blocking[];
        blockers: Blocking[];
      };
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
    const account = ctx.state.account;
    if (account == null) {
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
    return await withTransaction(ctx.state.fedCtx, async (context) => {
      const quote = await createNote(context, {
        ...parsed.output,
        accountId: account.id,
      }, { quotedPost: post });
      if (quote == null) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(JSON.stringify(quote), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
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
  ({ data: { post, quotes }, state }) => (
    <>
      <PostExcerpt
        post={post}
        noControls
        signedAccount={state.account}
      />
      <PostControls
        class="mt-4 ml-14"
        language={state.language}
        post={post}
        active="quote"
        signedAccount={state.account}
      />
      <div class="mt-8">
        {state.account == null
          ? (
            <>
              <hr class="my-4 ml-14 opacity-50 dark:opacity-25" />
              <p class="mt-4 leading-7 ml-14 text-stone-500 dark:text-stone-400 break-words">
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
  ),
);
