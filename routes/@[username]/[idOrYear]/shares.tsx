import { eq } from "drizzle-orm";
import { page } from "fresh";
import { ActorList } from "../../../components/ActorList.tsx";
import { Msg } from "../../../components/Msg.tsx";
import { PageTitle } from "../../../components/PageTitle.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { db } from "../../../db.ts";
import { NoteControls } from "../../../islands/NoteControls.tsx";
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
      where: eq(postTable.sharedPostId, note.post.id),
    });
    const sharers = shares
      .filter((s) => isPostVisibleTo(s, ctx.state.account?.actor))
      .map((s) => s.actor);
    return page<NoteSharedPeopleProps>({ note, sharers });
  },
});

interface NoteSharedPeopleProps {
  note: NonNullable<Awaited<ReturnType<typeof getNoteSource>>>;
  sharers: (Actor & { account?: Account | null })[];
}

export default define.page<typeof handler, NoteSharedPeopleProps>(
  function NoteSharedPeople({ data: { note, sharers }, state }) {
    const postUrl = `/@${note.account.username}/${note.id}`;
    return (
      <>
        <PostExcerpt
          post={note.post}
          noControls
          signedAccount={state.account}
        />
        <NoteControls
          class="mt-4 ml-14"
          language={state.language}
          active="sharedPeople"
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
          sharedPeopleUrl={`${postUrl}/shares`}
          deleteUrl={state.account == null ||
              state.account.id !== note.accountId
            ? undefined
            : postUrl}
        />
        <PageTitle class="mt-4">
          <Msg $key="note.sharedPeople" />
        </PageTitle>
        <ActorList actors={sharers} />
      </>
    );
  },
);
