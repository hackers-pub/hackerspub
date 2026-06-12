import { page } from "@fresh/core";
import {
  createNote,
  getNoteSource,
  QuotePolicyDeniedError,
} from "@hackerspub/models/note";
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
import { isPostCensoredFor, redactCensoredPost } from "../../../censorship.ts";
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
    // A censored share wrapper must not disclose what it boosted; its
    // quotes are listed for the wrapper itself (i.e. none).
    const targetPost = isPostCensoredFor(post, ctx.state.account)
      ? post
      : post.sharedPost ?? post;
    if (isPostCensoredFor(post, ctx.state.account)) {
      post = redactCensoredPost(post, ctx.state.t);
    }
    if (
      post.sharedPost != null &&
      isPostCensoredFor(post.sharedPost, ctx.state.account)
    ) {
      post = {
        ...post,
        sharedPost: redactCensoredPost(post.sharedPost, ctx.state.t),
      };
    }
    const quotes = await db.query.postTable.findMany({
      with: {
        actor: {
          with: {
            instance: true,
            followers: {
              where: ctx.state.account == null
                ? { RAW: sql`false` }
                : { followerId: ctx.state.account.actor.id },
            },
            blockees: {
              where: ctx.state.account == null
                ? { RAW: sql`false` }
                : { blockeeId: ctx.state.account.actor.id },
            },
            blockers: {
              where: ctx.state.account == null
                ? { RAW: sql`false` }
                : { blockerId: ctx.state.account.actor.id },
            },
          },
        },
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
        quotedPostId: targetPost.id,
        sharedPostId: { isNull: true },
      },
      orderBy: { published: "desc" },
    });
    return page<NoteQuotesProps>({
      post,
      quotes: quotes
        .filter((quote) => isPostVisibleTo(quote, ctx.state.account?.actor))
        .map((quote) =>
          isPostCensoredFor(quote, ctx.state.account)
            ? redactCensoredPost(quote, ctx.state.t)
            : quote
        ),
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
    // Neither a censored post nor a censored share wrapper can be quoted.
    if (
      isPostCensoredFor(post, ctx.state.account) ||
      post.sharedPost != null &&
        isPostCensoredFor(post.sharedPost, ctx.state.account)
    ) {
      return new Response("Invalid quotedPostId", { status: 400 });
    }
    const targetPost = post.sharedPost ?? post;
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
      let quote;
      try {
        quote = await createNote(context, {
          ...parsed.output,
          accountId: account.id,
        }, { quotedPost: targetPost });
      } catch (error) {
        if (error instanceof QuotePolicyDeniedError) {
          return new Response("Invalid quotedPostId", { status: 400 });
        }
        throw error;
      }
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
  ({ data: { post, quotes }, state }) => {
    const targetPost = post.sharedPost ?? post;
    return (
      <>
        <PostExcerpt
          canonicalOrigin={state.canonicalOrigin}
          post={post}
          noControls
          signedAccount={state.account}
        />
        <PostControls
          class="mt-4 ml-14"
          language={state.language}
          post={targetPost}
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
                        {targetPost.iri}
                      </span>
                    }
                  />
                </p>
              </>
            )
            : (
              <Composer
                canonicalOrigin={state.canonicalOrigin}
                defaultVisibility={state.account!.noteVisibility}
                language={state.language}
                postUrl=""
                noQuoteOnPaste
                onPost="post.url"
              />
            )}
          {quotes.map((quote) => (
            <PostExcerpt
              canonicalOrigin={state.canonicalOrigin}
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
