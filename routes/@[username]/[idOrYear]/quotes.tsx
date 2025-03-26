import { eq, sql } from "drizzle-orm";
import { page } from "fresh";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { PostReactionsNav } from "../../../components/PostReactionsNav.tsx";
import { db } from "../../../db.ts";
import { PostControls } from "../../../islands/PostControls.tsx";
import { getNoteSource } from "../../../models/note.ts";
import {
  type Actor,
  type Mention,
  type Post,
  type PostLink,
  type PostMedium,
  postTable,
} from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
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
  const sharers = await db.$count(
    postTable,
    eq(postTable.sharedPostId, note.post.id),
  );
  return page<NoteQuotesProps>({
    note,
    quotes,
    sharers,
  });
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
  sharers: number;
}

export default define.page<typeof handler, NoteQuotesProps>(
  function NoteQuotes(
    { data: { note, quotes, sharers }, state },
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
          active="sharedPeople"
          replies={note.post.repliesCount}
          replyUrl={`${postUrl}#replies`}
          shares={sharers}
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
          reactionsUrl={`${postUrl}/shares`}
          deleteUrl={state.account == null ||
              state.account.id !== note.accountId
            ? undefined
            : postUrl}
        />
        <div class="mt-4 ml-14">
          <PostReactionsNav
            active="quotes"
            hrefs={{ sharers: `${postUrl}/shares`, quotes: "" }}
            stats={{ sharers, quotes: quotes.length }}
          />
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
