import * as vocab from "@fedify/fedify/vocab";
import * as v from "@valibot/valibot";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { page } from "fresh";
import { Msg } from "../../../components/Msg.tsx";
import { NoteExcerpt } from "../../../components/NoteExcerpt.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { db } from "../../../db.ts";
import { drive } from "../../../drive.ts";
import { Composer } from "../../../islands/Composer.tsx";
import { NoteControls } from "../../../islands/NoteControls.tsx";
import { kv } from "../../../kv.ts";
import { getAvatarUrl } from "../../../models/actor.ts";
import { renderMarkup } from "../../../models/markup.ts";
import { createNote, getNoteSource, updateNote } from "../../../models/note.ts";
import {
  deletePost,
  getPostByUsernameAndId,
  isPostVisibleTo,
} from "../../../models/post.ts";
import {
  type Actor,
  actorTable,
  type Following,
  followingTable,
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
          replyTarget:
            | Post & {
              actor: Actor & { followers: Following[] };
              mentions: Mention[];
              media: PostMedium[];
            }
            | null;
          media: PostMedium[];
          shares: Post[];
        }
        | null;
      replyTarget:
        | Post & {
          actor: Actor & { followers: Following[] };
          mentions: Mention[];
          media: PostMedium[];
        }
        | null;
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
            replyTarget: {
              with: {
                actor: {
                  with: {
                    followers: {
                      where: ctx.state.account == null ? sql`false` : eq(
                        followingTable.followerId,
                        ctx.state.account.actor.id,
                      ),
                    },
                  },
                },
                mentions: true,
                media: true,
              },
            },
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
                replyTarget: {
                  with: {
                    actor: {
                      with: {
                        followers: {
                          where: ctx.state.account == null ? sql`false` : eq(
                            followingTable.followerId,
                            ctx.state.account.actor.id,
                          ),
                        },
                      },
                    },
                    mentions: true,
                    media: true,
                  },
                },
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
          ctx.state.account?.moderator &&
            ctx.url.searchParams.has("refresh") ||
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
        ctx.state.metas.push(
          { name: "og:url", content: permalink.href },
        );
        postUrl = `/@${note.account.username}/${note.id}`;
      }
    }
    if (!isPostVisibleTo(post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    let replies = await db.query.postTable.findMany({
      with: {
        actor: {
          with: {
            followers: {
              where: ctx.state.account == null ? sql`false` : eq(
                followingTable.followerId,
                ctx.state.account.actor.id,
              ),
            },
          },
        },
        mentions: true,
        media: true,
      },
      where: eq(postTable.replyTargetId, post.sharedPostId ?? post.id),
      orderBy: postTable.published,
    });
    replies = replies.filter((reply) =>
      isPostVisibleTo(reply, ctx.state.account?.actor)
    );
    const content = await renderMarkup(
      db,
      ctx.state.fedCtx,
      post.id,
      post.contentHtml,
    );
    const authorHandle = `@${post.actor.username}@${post.actor.instanceHost}`;
    const author = post.actor.name ?? authorHandle;
    ctx.state.title = ctx.state.t("note.title", {
      name: author,
      content: content.text,
    });
    ctx.state.metas.push(
      { name: "description", content: content.text },
      { property: "og:title", content: content.text },
      { property: "og:description", content: content.text },
      { property: "og:type", content: "article" },
      {
        property: "article:published_time",
        content: post.published.toISOString(),
      },
      {
        property: "article:modified_time",
        content: post.updated.toISOString(),
      },
      { property: "article:author", content: author },
      { property: "article:author.username", content: post.actor.username },
      ...Object.keys(post.tags).map((tag) => ({
        property: "article:tag",
        content: tag,
      })),
      { name: "fediverse:creator", content: authorHandle },
    );
    if (post.language != null) {
      ctx.state.metas.push({ property: "og:locale", content: post.language });
    }
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

  async DELETE(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    if (ctx.params.username.includes("@")) return ctx.next();
    if (ctx.state.account == null) return ctx.next();
    const id = ctx.params.idOrYear;
    const note = await getNoteSource(db, ctx.params.username, id);
    if (note == null || note.accountId !== ctx.state.account.id) {
      return ctx.next();
    }
    const post: Post & { actor: Actor } = {
      ...note.post,
      actor: ctx.state.account.actor,
    };
    await deletePost(db, ctx.state.fedCtx, post);
    return new Response(null, { status: 202 });
  },
});

type NotePageProps = {
  post: Post & {
    actor: Actor;
    sharedPost:
      | Post & {
        actor: Actor;
        replyTarget:
          | Post & {
            actor: Actor & { followers: Following[] };
            mentions: Mention[];
            media: PostMedium[];
          }
          | null;
        media: PostMedium[];
        shares: Post[];
      }
      | null;
    replyTarget:
      | Post & {
        actor: Actor & { followers: Following[] };
        mentions: Mention[];
        media: PostMedium[];
      }
      | null;
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
        <PostExcerpt post={post} noControls />
        <NoteControls
          class="mt-4 ml-14"
          language={state.language}
          replies={replies.length}
          shares={(post.sharedPost ?? post).sharesCount}
          shareUrl={state.account == null ||
              !["public", "unlisted"].includes(post.visibility)
            ? undefined
            : `${postUrl}/share`}
          unshareUrl={state.account == null ||
              !["public", "unlisted"].includes(post.visibility)
            ? undefined
            : `${postUrl}/unshare`}
          shared={(post.sharedPost ?? post).shares.some((share) =>
            share.actorId === state.account?.actor.id
          )}
        />
        {state.account == null
          ? (
            <>
              <hr class="my-4 ml-14 opacity-50 dark:opacity-25" />
              <p class="mt-4 leading-7 ml-14 text-stone-500 dark:text-stone-400">
                <Msg
                  $key="note.remoteReplyDescription"
                  permalink={
                    <span class="font-bold border-dashed border-b-[1px] select-all text-stone-950 dark:text-stone-50">
                      {post.iri}
                    </span>
                  }
                />
              </p>
            </>
          )
          : (
            <Composer
              class="mt-8"
              language={state.language}
              postUrl={postUrl}
              commentTarget={authorHandle}
              textAreaId="reply"
              onPost="reload"
              defaultVisibility={post.visibility}
            />
          )}
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
            authorEmojis={reply.actor.emojis}
            media={reply.media}
            published={reply.published}
          />
        ))}
      </>
    );
  },
);
