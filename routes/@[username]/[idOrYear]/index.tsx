import * as vocab from "@fedify/fedify/vocab";
import * as v from "@valibot/valibot";
import { page } from "fresh";
import { NoteExcerpt } from "../../../components/NoteExcerpt.tsx";
import { db } from "../../../db.ts";
import { Composer } from "../../../islands/Composer.tsx";
import { kv } from "../../../kv.ts";
import { getAvatarUrl } from "../../../models/account.ts";
import { getAvatarUrl as getActorAvatarUrl } from "../../../models/actor.ts";
import { renderMarkup } from "../../../models/markup.ts";
import { createNote, getNoteSource } from "../../../models/note.ts";
import { isPostVisibleTo } from "../../../models/post.ts";
import {
  type Account,
  type Actor,
  type NoteSource,
  type Post,
  postTable,
} from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";
import { NoteSourceSchema } from "../index.tsx";
import { eq } from "drizzle-orm";

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    const note = await getNoteSource(db, ctx.params.username, id);
    if (note == null) return ctx.next();
    if (!isPostVisibleTo(note.post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const noteUri = ctx.state.fedCtx.getObjectUri(vocab.Note, { id: note.id });
    ctx.state.links.push(
      {
        rel: "canonical",
        href: new URL(`/@${note.account.username}/${note.id}`, ctx.url),
      },
      {
        rel: "alternate",
        type: "application/activity+json",
        href: noteUri,
      },
    );
    const replies = await db.query.postTable.findMany({
      with: { actor: true },
      where: eq(postTable.replyTargetId, note.post.id),
      orderBy: postTable.published,
    });
    return page<NotePageProps>({
      note,
      replies,
      avatarUrl: await getAvatarUrl(note.account),
      contentHtml:
        (await renderMarkup(db, ctx.state.fedCtx, note.id, note.content)).html,
    }, {
      headers: {
        Link:
          `<${noteUri.href}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },

  async POST(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    const note = await getNoteSource(db, ctx.params.username, id);
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
    const post = await createNote(db, kv, ctx.state.fedCtx, {
      ...parsed.output,
      accountId: ctx.state.account.id,
    }, note.post);
    if (post == null) {
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response(JSON.stringify(post), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  },
});

interface NotePageProps {
  note: NoteSource & { account: Account; post: Post };
  replies: (Post & { actor: Actor })[];
  avatarUrl: string;
  contentHtml: string;
}

export default define.page<typeof handler, NotePageProps>(
  function NotePage(
    { url, state, data: { note, replies, avatarUrl, contentHtml } },
  ) {
    const postUrl = `/@${note.account.username}/${note.id}`;
    const authorHandle = `@${note.account.username}@${url.host}`;
    return (
      <>
        <NoteExcerpt
          url={postUrl}
          contentHtml={contentHtml}
          lang={note.language}
          visibility={note.visibility}
          authorUrl={`/@${note.account.username}`}
          authorName={note.account.name}
          authorHandle={authorHandle}
          authorAvatarUrl={avatarUrl}
          published={note.published}
        />
        <Composer
          class="mt-8"
          language={state.language}
          postUrl={postUrl}
          commentTarget={authorHandle}
        />
        {replies.map((reply) => (
          <NoteExcerpt
            url={reply.url ?? reply.iri}
            contentHtml={reply.contentHtml}
            lang={reply.language ?? undefined}
            visibility={reply.visibility}
            authorUrl={reply.actor.url ?? reply.actor.iri}
            authorName={reply.actor.name ?? reply.actor.username}
            authorHandle={`@${reply.actor.username}@${reply.actor.instanceHost}`}
            authorAvatarUrl={getActorAvatarUrl(reply.actor)}
            published={reply.published}
          />
        ))}
      </>
    );
  },
);
