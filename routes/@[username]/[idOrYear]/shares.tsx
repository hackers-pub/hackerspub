import { page } from "fresh";
import { ActorList } from "../../../components/ActorList.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { PostReactionsNav } from "../../../components/PostReactionsNav.tsx";
import { db } from "../../../db.ts";
import { drive } from "../../../drive.ts";
import { PostControls } from "../../../islands/PostControls.tsx";
import { kv } from "../../../kv.ts";
import { extractMentionsFromHtml } from "../../../models/markup.ts";
import { getNoteSource } from "../../../models/note.ts";
import { getPostVisibilityFilter } from "../../../models/post.ts";
import type { Account, Actor } from "../../../models/schema.ts";
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
  const shares = await db.query.postTable.findMany({
    with: { actor: { with: { account: true } } },
    where: {
      AND: [
        { sharedPostId: note.post.id },
        getPostVisibilityFilter(ctx.state.account?.actor ?? null),
      ],
    },
    orderBy: { published: "desc" },
  });
  const sharers = shares.map((s) => s.actor);
  const disk = drive.use();
  const sharersMentions = await extractMentionsFromHtml(
    db,
    disk,
    ctx.state.fedCtx,
    sharers.map((s) => s.bioHtml).join("\n"),
    {
      documentLoader: await ctx.state.fedCtx.getDocumentLoader(note.account),
      kv,
    },
  );
  return page<NoteSharedPeopleProps>({
    note,
    sharers,
    sharersMentions,
  });
});

interface NoteSharedPeopleProps {
  note: NonNullable<Awaited<ReturnType<typeof getNoteSource>>>;
  sharers: (Actor & { account?: Account | null })[];
  sharersMentions: { actor: Actor }[];
}

export default define.page<typeof handler, NoteSharedPeopleProps>(
  ({ data: { note, sharers, sharersMentions }, state }) => (
    <>
      <PostExcerpt
        post={note.post}
        noControls
        signedAccount={state.account}
      />
      <PostControls
        class="mt-4 ml-14"
        language={state.language}
        post={note.post}
        active="reactions"
        signedAccount={state.account}
      />
      <div class="mt-4 ml-14">
        <PostReactionsNav
          active="sharers"
          hrefs={{ reactions: "./reactions", sharers: "" }}
          stats={{
            reactions: note.post.reactionsCount,
            sharers: sharers.length,
          }}
        />
        <ActorList
          actors={sharers}
          actorMentions={sharersMentions}
          class="mt-4"
        />
      </div>
    </>
  ),
);
