import * as v from "@valibot/valibot";
import { sql } from "drizzle-orm";
import { page } from "fresh";
import { Msg } from "../../../components/Msg.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { db } from "../../../db.ts";
import { drive } from "../../../drive.ts";
import { Composer } from "../../../islands/Composer.tsx";
import { PostControls } from "../../../islands/PostControls.tsx";
import { kv } from "../../../kv.ts";
import { createNote, getNoteSource } from "../../../models/note.ts";
import { isPostVisibleTo } from "../../../models/post.ts";
import type {
  Actor,
  Mention,
  Post,
  PostLink,
  PostMedium,
} from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";
import { NoteSourceSchema } from "../index.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    if (ctx.params.username.includes("@")) return ctx.next();
    const note = await getNoteSource(
      db,
      ctx.params.username,
      id,
      ctx.state.account,
    );
    if (note == null) return ctx.next();
    if (!isPostVisibleTo(note.post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const quotes = await db.query.postTable.findMany({
      with: {
        actor: true,
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
      },
      where: {
        quotedPostId: note.post.id,
        sharedPostId: { isNull: true },
      },
      orderBy: { published: "desc" },
    });
    return page<NoteQuotesProps>({
      note,
      quotes,
    });
  },

  async POST(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    if (ctx.params.username.includes("@")) return ctx.next();
    const note = await getNoteSource(
      db,
      ctx.params.username,
      id,
      ctx.state.account,
    );
    if (note == null) return ctx.next();
    if (!isPostVisibleTo(note.post, ctx.state.account?.actor)) {
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
    }, { quotedPost: note.post });
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
  note: NonNullable<Awaited<ReturnType<typeof getNoteSource>>>;
  quotes: (
    Post & {
      actor: Actor;
      link: PostLink & { creator?: Actor | null } | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
    }
  )[];
}

export default define.page<typeof handler, NoteQuotesProps>(
  function NoteQuotes(
    { data: { note, quotes }, state },
  ) {
    const postUrl = `/@${note.account.username}/${note.id}`;
    return (
      <>
        <PostExcerpt
          post={note.post}
          noControls
          signedAccount={state.account}
        />
        <PostControls
          class="mt-4 ml-14"
          language={state.language}
          active="quote"
          replies={note.post.repliesCount}
          replyUrl={`${postUrl}#replies`}
          shares={note.post.sharesCount}
          shareUrl={state.account == null ||
              !["public", "unlisted"].includes(note.post.visibility)
            ? undefined
            : `${postUrl}/share`}
          unshareUrl={state.account == null ||
              !["public", "unlisted"].includes(note.post.visibility)
            ? undefined
            : `${postUrl}/unshare`}
          shared={note.post.shares.some((share) =>
            share.actorId === state.account?.actor.id
          )}
          quoteUrl=""
          quotesCount={quotes.length}
          reactionsUrl={`${postUrl}/shares`}
          deleteUrl={state.account == null ||
              state.account.id !== note.accountId
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
                        {note.post.iri}
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
                onPost="javascript:location.href = post.url"
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
