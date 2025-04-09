import { page } from "fresh";
import { ActorList } from "../../../components/ActorList.tsx";
import { Msg } from "../../../components/Msg.tsx";
import { PageTitle } from "../../../components/PageTitle.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { PostReactionsNav } from "../../../components/PostReactionsNav.tsx";
import { db } from "../../../db.ts";
import { PostControls } from "../../../islands/PostControls.tsx";
import { kv } from "../../../kv.ts";
import { extractMentionsFromHtml } from "../../../models/markup.ts";
import { getNoteSource } from "../../../models/note.ts";
import type { Account, Actor, CustomEmoji } from "../../../models/schema.ts";
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
  const reactions = await db.query.reactionTable.findMany({
    with: {
      actor: {
        with: { account: true },
      },
      customEmoji: true,
    },
    where: { postId: note.post.id },
    orderBy: { created: "desc" },
  });
  const map = new Map<
    string | string,
    (Actor & { account: Account | null })[]
  >();
  const customEmojis = new Map<string, CustomEmoji>();
  for (const reaction of reactions) {
    const emoji = reaction.customEmoji?.id ?? reaction.emoji;
    if (emoji == null) continue;
    const actor = reaction.actor;
    const list = map.get(emoji);
    if (list == null) {
      map.set(emoji, [actor]);
    } else {
      list.push(actor);
    }
    if (reaction.customEmoji != null) {
      customEmojis.set(reaction.customEmoji.id, reaction.customEmoji);
    }
  }
  const pairs: [
    string | CustomEmoji,
    (Actor & { account: Account | null })[],
  ][] = [];
  for (const [key, value] of map.entries()) {
    pairs.push([customEmojis.get(key) ?? key, value]);
  }
  pairs.sort((a, b) => {
    const aCount = a[1].length;
    const bCount = b[1].length;
    if (aCount === bCount) {
      return a[0].toString().localeCompare(b[0].toString());
    }
    return bCount - aCount;
  });
  const reactorsMentions = await extractMentionsFromHtml(
    db,
    ctx.state.fedCtx,
    pairs.flatMap(([_, s]) => s.map((a) => a.bioHtml)).join("\n"),
    {
      documentLoader: await ctx.state.fedCtx.getDocumentLoader(
        note.account,
      ),
      kv,
    },
  );
  return page<NoteReactionsProps>({
    note,
    reactions: pairs,
    reactorsMentions,
    total: reactions.length,
  });
});

interface NoteReactionsProps {
  note: NonNullable<Awaited<ReturnType<typeof getNoteSource>>>;
  reactions: [string | CustomEmoji, (Actor & { account: Account | null })[]][];
  reactorsMentions: { actor: Actor }[];
  total: number;
}

export default define.page<typeof handler, NoteReactionsProps>(
  ({ data: { note, reactions, reactorsMentions, total }, state }) => (
    <div>
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
          active="reactions"
          hrefs={{ reactions: "", sharers: "./shares" }}
          stats={{ reactions: total, sharers: note.post.sharesCount }}
        />
        {reactions.map(([emoji, actors]) => (
          <div
            key={typeof emoji === "string" ? emoji : emoji.id}
            class="mt-4"
          >
            <PageTitle
              subtitle={{
                text: (
                  <Msg
                    $key="post.reactions.reactedPeople"
                    count={actors.length}
                  />
                ),
              }}
            >
              {typeof emoji === "string"
                ? emoji
                : <img src={emoji.imageUrl} alt={emoji.name} class="h-4" />}
            </PageTitle>
            <ActorList
              actors={actors}
              actorMentions={reactorsMentions}
              class="mt-4"
            />
          </div>
        ))}
      </div>
    </div>
  ),
);
