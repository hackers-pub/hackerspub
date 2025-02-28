import * as vocab from "@fedify/fedify/vocab";
import * as v from "@valibot/valibot";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { page } from "fresh";
import { NoteExcerpt } from "../../../components/NoteExcerpt.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { db } from "../../../db.ts";
import { drive } from "../../../drive.ts";
import { Composer } from "../../../islands/Composer.tsx";
import { NoteControls } from "../../../islands/NoteControls.tsx";
import { kv } from "../../../kv.ts";
import { getAvatarUrl } from "../../../models/actor.ts";
import { createNote, getNoteSource, updateNote } from "../../../models/note.ts";
import {
  getPostByUsernameAndId,
  isPostVisibleTo,
} from "../../../models/post.ts";
import {
  type Actor,
  actorTable,
  type Following,
  type Mention,
  type Post,
  type PostMedium,
  postTable,
} from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";
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
          replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
          media: PostMedium[];
          shares: Post[];
        }
        | null;
      replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
      mentions: Mention[];
      media: PostMedium[];
      shares: Post[];
    };
    let postUrl: string;
    let noteUri: URL | undefined;
    if (ctx.params.username.includes("@")) {
      if (ctx.params.username.endsWith(`@${ctx.url.host}`)) {
        return ctx.redirect(`/@${ctx.params.username}/${id}`);
      }
      const result = await getPostByUsernameAndId(db, ctx.params.username, id);
      if (result == null) return ctx.next();
      post = result;
      postUrl = `/@${ctx.params.username}/${post.id}`;
    } else {
      const note = await getNoteSource(db, ctx.params.username, id);
      if (note == null) {
        const share = await db.query.postTable.findFirst({
          with: {
            actor: { with: { followers: true } },
            replyTarget: { with: { actor: true, media: true } },
            mentions: true,
            media: true,
            shares: {
              where: ctx.state.account == null
                ? sql`false`
                : eq(postTable.actorId, ctx.state.account.actor.id),
            },
            sharedPost: {
              with: {
                actor: { with: { followers: true } },
                replyTarget: { with: { actor: true, media: true } },
                mentions: true,
                media: true,
                shares: {
                  where: ctx.state.account == null
                    ? sql`false`
                    : eq(postTable.actorId, ctx.state.account.actor.id),
                },
              },
            },
          },
          where: and(
            eq(postTable.id, id),
            isNotNull(postTable.sharedPostId),
            inArray(
              postTable.actorId,
              db.select({ id: actorTable.id })
                .from(actorTable)
                .where(and(
                  eq(actorTable.username, ctx.params.username),
                  isNotNull(actorTable.accountId),
                )),
            ),
          ),
        });
        if (share == null || share.sharedPost == null) return ctx.next();
        post = share;
        postUrl = share.sharedPost.actor.accountId == null
          ? `/@${share.sharedPost.actor.username}@${share.sharedPost.actor.instanceHost}/${share.sharedPostId}`
          : `/@${share.sharedPost.actor.username}/${
            share.sharedPost.articleSourceId ?? share.sharedPost.noteSourceId
          }`;
      } else {
        post = note.post;
        const permalink = new URL(
          `/@${note.account.username}/${note.id}`,
          ctx.state.canonicalOrigin,
        );
        if (
          note.account.username !== ctx.params.username &&
          post.url !== permalink.href
        ) {
          const disk = drive.use();
          await updateNote(db, kv, disk, ctx.state.fedCtx, note.id, {});
        }
        noteUri = ctx.state.fedCtx.getObjectUri(vocab.Note, {
          id: note.id,
        });
        ctx.state.links.push(
          {
            rel: "canonical",
            href: permalink,
          },
          {
            rel: "alternate",
            type: "application/activity+json",
            href: noteUri,
          },
        );
        postUrl = `/@${note.account.username}/${note.id}`;
      }
    }
    if (!isPostVisibleTo(post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const replies = await db.query.postTable.findMany({
      with: { actor: true, media: true },
      where: eq(postTable.replyTargetId, post.sharedPostId ?? post.id),
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
      const result = await getPostByUsernameAndId(db, ctx.params.username, id);
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
    const disk = drive.use();
    const reply = await createNote(db, kv, disk, ctx.state.fedCtx, {
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

type NotePageProps = {
  post: Post & {
    actor: Actor;
    sharedPost:
      | Post & {
        actor: Actor;
        replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
        media: PostMedium[];
        shares: Post[];
      }
      | null;
    replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
    media: PostMedium[];
    shares: Post[];
  };
  postUrl: string;
  replies: (Post & { actor: Actor; media: PostMedium[] })[];
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
          shares={(post.sharedPost ?? post).sharesCount}
          shareUrl={`${postUrl}/share`}
          unshareUrl={`${postUrl}/unshare`}
          shared={(post.sharedPost ?? post).shares.some((share) =>
            share.actorId === state.account?.actor.id
          )}
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
            internalUrl={reply.noteSourceId == null
              ? `/@${reply.actor.username}@${reply.actor.instanceHost}/${reply.id}`
              : `/@${reply.actor.username}/${reply.noteSourceId}`}
            contentHtml={reply.contentHtml}
            lang={reply.language ?? undefined}
            visibility={reply.visibility}
            authorUrl={reply.actor.url ?? reply.actor.iri}
            authorInternalUrl={reply.actor.accountId == null
              ? `/@${reply.actor.username}@${reply.actor.instanceHost}`
              : `/@${reply.actor.username}`}
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
