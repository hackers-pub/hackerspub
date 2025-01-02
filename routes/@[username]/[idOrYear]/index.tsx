import * as vocab from "@fedify/fedify/vocab";
import * as v from "@valibot/valibot";
import { and, eq, inArray } from "drizzle-orm";
import { page } from "fresh";
import { NoteExcerpt } from "../../../components/NoteExcerpt.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { db } from "../../../db.ts";
import { Composer } from "../../../islands/Composer.tsx";
import { NoteControls } from "../../../islands/NoteControls.tsx";
import { kv } from "../../../kv.ts";
import { getAvatarUrl } from "../../../models/actor.ts";
import { createNote, getNoteSource } from "../../../models/note.ts";
import { isPostVisibleTo } from "../../../models/post.ts";
import {
  type Actor,
  actorTable,
  type Following,
  type Medium,
  type Mention,
  type Post,
  postTable,
} from "../../../models/schema.ts";
import { Uuid, validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";
import { NoteSourceSchema } from "../index.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    let post: Post & {
      actor: Actor & { followers: Following[] };
      sharedPost:
        | Post & {
          actor: Actor;
          replyTarget: Post & { actor: Actor; media: Medium[] } | null;
          media: Medium[];
        }
        | null;
      replyTarget: Post & { actor: Actor; media: Medium[] } | null;
      mentions: Mention[];
      media: Medium[];
    };
    let postUrl: string;
    let noteUri: URL | undefined;
    if (ctx.params.username.includes("@")) {
      if (ctx.params.username.endsWith(`@${ctx.url.host}`)) {
        return ctx.redirect(`/@${ctx.params.username}/${id}`);
      }
      const result = await getPost(ctx.params.username, id);
      if (result == null) return ctx.next();
      post = result;
      postUrl = `/@${ctx.params.username}/${post.id}`;
    } else {
      const note = await getNoteSource(db, ctx.params.username, id);
      if (note == null) return ctx.next();
      post = note.post;
      noteUri = ctx.state.fedCtx.getObjectUri(vocab.Note, {
        id: note.id,
      });
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
      postUrl = `/@${note.account.username}/${note.id}`;
    }
    if (!isPostVisibleTo(post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const replies = await db.query.postTable.findMany({
      with: { actor: true, media: true },
      where: eq(postTable.replyTargetId, post.id),
      orderBy: postTable.published,
    });
    return page<NotePageProps>(
      {
        post,
        postUrl,
        replies,
      },
      noteUri == null ? undefined : {
        headers: {
          Link:
            `<${noteUri.href}>; rel="alternate"; type="application/activity+json"`,
        },
      },
    );
  },

  async POST(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    let post: Post & {
      actor: Actor & { followers: Following[] };
      replyTarget: Post & { actor: Actor } | null;
      mentions: Mention[];
    };
    if (ctx.params.username.includes("@")) {
      if (ctx.params.username.endsWith(`@${ctx.url.host}`)) {
        return ctx.redirect(`/@${ctx.params.username}/${id}`);
      }
      const result = await getPost(ctx.params.username, id);
      if (result == null) return ctx.next();
      post = result;
    } else {
      const note = await getNoteSource(db, ctx.params.username, id);
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
    const reply = await createNote(db, kv, ctx.state.fedCtx, {
      ...parsed.output,
      accountId: ctx.state.account.id,
    }, post);
    if (reply == null) {
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response(JSON.stringify(reply), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  },
});

function getPost(
  username: string,
  id: Uuid,
): Promise<
  | Post & {
    actor: Actor & { followers: Following[] };
    sharedPost:
      | Post & {
        actor: Actor;
        replyTarget: Post & { actor: Actor; media: Medium[] } | null;
        media: Medium[];
      }
      | null;
    replyTarget: Post & { actor: Actor; media: Medium[] } | null;
    mentions: Mention[];
    media: Medium[];
  }
  | undefined
> {
  if (!username.includes("@")) return Promise.resolve(undefined);
  let host: string;
  [username, host] = username.split("@");
  return db.query.postTable.findFirst({
    with: {
      actor: {
        with: { followers: true },
      },
      sharedPost: {
        with: {
          actor: true,
          replyTarget: {
            with: { actor: true, media: true },
          },
          media: true,
        },
      },
      replyTarget: {
        with: { actor: true, media: true },
      },
      mentions: true,
      media: true,
    },
    where: and(
      inArray(
        postTable.actorId,
        db.select({ id: actorTable.id }).from(actorTable).where(
          and(
            eq(actorTable.username, username),
            eq(actorTable.instanceHost, host),
          ),
        ),
      ),
      eq(postTable.id, id),
    ),
  });
}

type NotePageProps = {
  post: Post & {
    actor: Actor;
    sharedPost:
      | Post & {
        actor: Actor;
        replyTarget: Post & { actor: Actor; media: Medium[] } | null;
        media: Medium[];
      }
      | null;
    replyTarget: Post & { actor: Actor; media: Medium[] } | null;
    media: Medium[];
  };
  postUrl: string;
  replies: (Post & { actor: Actor; media: Medium[] })[];
};

export default define.page<typeof handler, NotePageProps>(
  function NotePage(
    {
      state,
      data: { post, postUrl, replies },
    },
  ) {
    const authorHandle = `@${post.actor.username}@${post.actor.instanceHost}`;
    return (
      <>
        <PostExcerpt post={post} />
        <NoteControls
          class="mt-4 ml-14"
          language={state.language}
          replies={replies.length}
          shares={post.sharesCount}
        />
        <Composer
          class="mt-8"
          language={state.language}
          postUrl={postUrl}
          commentTarget={authorHandle}
          textAreaId="reply"
          onPost="reload"
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
            authorAvatarUrl={getAvatarUrl(reply.actor)}
            media={reply.media}
            published={reply.published}
          />
        ))}
      </>
    );
  },
);
