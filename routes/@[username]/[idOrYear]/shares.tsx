import { eq } from "drizzle-orm";
import { page } from "fresh";
import { ActorList } from "../../../components/ActorList.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { PostReactionsNav } from "../../../components/PostReactionsNav.tsx";
import { db } from "../../../db.ts";
import { PostControls } from "../../../islands/PostControls.tsx";
import { extractMentionsFromHtml } from "../../../models/markup.ts";
import { getNoteSource } from "../../../models/note.ts";
import { isPostVisibleTo } from "../../../models/post.ts";
import { type Account, type Actor, postTable } from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";

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
    const shares = await db.query.postTable.findMany({
      with: {
        actor: {
          with: { account: true, followers: true },
        },
        mentions: true,
      },
      where: { sharedPostId: note.post.id },
      orderBy: { published: "desc" },
    });
    const sharers = shares
      .filter((s) => isPostVisibleTo(s, ctx.state.account?.actor))
      .map((s) => s.actor);
    const sharersMentions = await extractMentionsFromHtml(
      db,
      ctx.state.fedCtx,
      sharers.map((s) => s.bioHtml).join("\n"),
      {
        documentLoader: await ctx.state.fedCtx.getDocumentLoader(note.account),
      },
    );
    const quotes = await db.$count(
      postTable,
      eq(postTable.quotedPostId, note.post.id),
    );
    return page<NoteSharedPeopleProps>({
      note,
      sharers,
      sharersMentions,
      quotes,
    });
  },
});

interface NoteSharedPeopleProps {
  note: NonNullable<Awaited<ReturnType<typeof getNoteSource>>>;
  sharers: (Actor & { account?: Account | null })[];
  sharersMentions: { actor: Actor }[];
  quotes: number;
}

export default define.page<typeof handler, NoteSharedPeopleProps>(
  function NoteSharedPeople(
    { data: { note, sharers, sharersMentions, quotes }, state },
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
          shares={sharers.length}
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
            active="sharers"
            hrefs={{ sharers: "", quotes: `${postUrl}/quotes` }}
            stats={{ sharers: sharers.length, quotes }}
          />
          <ActorList
            actors={sharers}
            actorMentions={sharersMentions}
            class="mt-4"
          />
        </div>
      </>
    );
  },
);
