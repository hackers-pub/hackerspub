import * as vocab from "@fedify/fedify/vocab";
import * as v from "@valibot/valibot";
import { sql } from "drizzle-orm";
import { page } from "fresh";
import { Msg } from "../../../components/Msg.tsx";
import { NoteExcerpt } from "../../../components/NoteExcerpt.tsx";
import { PostExcerpt } from "../../../components/PostExcerpt.tsx";
import { db } from "../../../db.ts";
import { drive } from "../../../drive.ts";
import { Composer } from "../../../islands/Composer.tsx";
import { PostControls } from "../../../islands/PostControls.tsx";
import { kv } from "../../../kv.ts";
import { renderMarkup } from "../../../models/markup.ts";
import { createNote, getNoteSource, updateNote } from "../../../models/note.ts";
import {
  deletePost,
  getPostByUsernameAndId,
  isPostObject,
  isPostVisibleTo,
  persistPost,
  updateSharesCount,
} from "../../../models/post.ts";
import type {
  Actor,
  Blocking,
  Following,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "../../../models/schema.ts";
import { type Uuid, validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";
import { NoteSourceSchema } from "../index.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    let post: Post & {
      actor: Actor & {
        instance: Instance;
        followers: Following[];
        blockees: Blocking[];
        blockers: Blocking[];
      };
      link: PostLink & { creator?: Actor | null } | null;
      sharedPost:
        | Post & {
          actor: Actor & { instance: Instance };
          link: PostLink & { creator?: Actor | null } | null;
          replyTarget:
            | Post & {
              actor: Actor & { instance: Instance; followers: Following[] };
              link: PostLink & { creator?: Actor | null } | null;
              mentions: (Mention & { actor: Actor })[];
              media: PostMedium[];
            }
            | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
          shares: Post[];
          reactions: Reaction[];
        }
        | null;
      replyTarget:
        | Post & {
          actor: Actor & {
            instance: Instance;
            followers: Following[];
            blockees: Blocking[];
            blockers: Blocking[];
          };
          link: PostLink & { creator?: Actor | null } | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
        }
        | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
      reactions: Reaction[];
    };
    let postUrl: string;
    let noteUri: URL | undefined;
    if (ctx.params.username.includes("@")) {
      if (ctx.params.username.endsWith(`@${ctx.url.host}`)) {
        return ctx.redirect(`/@${ctx.params.username}/${id}`);
      }
      const result = await getPostByUsernameAndId(
        db,
        ctx.params.username,
        id,
        ctx.state.account,
      );
      if (result == null) return ctx.next();
      if (ctx.state.account == null) {
        const original = result.sharedPost ?? result;
        return ctx.redirect(original.url ?? original.iri, 301);
      }
      post = result;
      if (ctx.url.searchParams.has("refresh") && ctx.state.account?.moderator) {
        const documentLoader = await ctx.state.fedCtx.getDocumentLoader({
          identifier: ctx.state.account.id,
        });
        const object = await ctx.state.fedCtx.lookupObject(
          post.iri,
          { documentLoader },
        );
        if (isPostObject(object)) {
          await persistPost(db, ctx.state.fedCtx, object, { documentLoader });
        }
      }
      postUrl = `/@${ctx.params.username}/${post.id}`;
    } else {
      const note = await getNoteSource(
        db,
        ctx.params.username,
        id,
        ctx.state.account,
      );
      if (note == null) {
        const share = await db.query.postTable.findFirst({
          with: {
            actor: {
              with: {
                instance: true,
                followers: {
                  where: ctx.state.account == null
                    ? { RAW: sql`false` }
                    : { followerId: ctx.state.account.actor.id },
                },
                blockees: {
                  where: ctx.state.account == null
                    ? { RAW: sql`false` }
                    : { blockeeId: ctx.state.account.actor.id },
                },
                blockers: {
                  where: ctx.state.account == null
                    ? { RAW: sql`false` }
                    : { blockerId: ctx.state.account.actor.id },
                },
              },
            },
            link: { with: { creator: true } },
            replyTarget: {
              with: {
                actor: {
                  with: {
                    instance: true,
                    followers: {
                      where: ctx.state.account == null
                        ? { RAW: sql`false` }
                        : { followerId: ctx.state.account.actor.id },
                    },
                    blockees: {
                      where: ctx.state.account == null
                        ? { RAW: sql`false` }
                        : { blockeeId: ctx.state.account.actor.id },
                    },
                    blockers: {
                      where: ctx.state.account == null
                        ? { RAW: sql`false` }
                        : { blockerId: ctx.state.account.actor.id },
                    },
                  },
                },
                link: { with: { creator: true } },
                mentions: {
                  with: { actor: true },
                },
                media: true,
              },
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
            reactions: {
              where: ctx.state.account == null
                ? { RAW: sql`false` }
                : { actorId: ctx.state.account.actor.id },
            },
            sharedPost: {
              with: {
                actor: { with: { instance: true, followers: true } },
                link: { with: { creator: true } },
                replyTarget: {
                  with: {
                    actor: {
                      with: {
                        instance: true,
                        followers: {
                          where: ctx.state.account == null
                            ? { RAW: sql`false` }
                            : { followerId: ctx.state.account.actor.id },
                        },
                      },
                    },
                    link: { with: { creator: true } },
                    mentions: {
                      with: { actor: true },
                    },
                    media: true,
                  },
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
                reactions: {
                  where: ctx.state.account == null
                    ? { RAW: sql`false` }
                    : { actorId: ctx.state.account.actor.id },
                },
              },
            },
          },
          where: {
            id,
            sharedPostId: { isNotNull: true },
            actor: {
              username: ctx.params.username,
              accountId: { isNotNull: true },
            },
          },
        });
        if (share == null || share.sharedPost == null) return ctx.next();
        post = share;
        postUrl = share.sharedPost.actor.accountId == null
          ? `/${share.sharedPost.actor.handle}/${share.sharedPostId}`
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
    if (post.noteSourceId != null) {
      post.sharesCount = await updateSharesCount(db, post, 0);
    }
    let replies = await db.query.postTable.findMany({
      with: {
        actor: {
          with: {
            followers: {
              where: ctx.state.account == null
                ? { RAW: sql`false` }
                : { followerId: ctx.state.account.actor.id },
            },
            blockees: {
              where: ctx.state.account == null
                ? { RAW: sql`false` }
                : { blockeeId: ctx.state.account.actor.id },
            },
            blockers: {
              where: ctx.state.account == null
                ? { RAW: sql`false` }
                : { blockerId: ctx.state.account.actor.id },
            },
          },
        },
        link: { with: { creator: true } },
        mentions: {
          with: { actor: true },
        },
        media: true,
        shares: {
          where: ctx.state.account == null
            ? { RAW: sql`false` }
            : { actorId: ctx.state.account.actor.id },
        },
        reactions: {
          where: ctx.state.account == null
            ? { RAW: sql`false` }
            : { actorId: ctx.state.account.actor.id },
        },
      },
      where: { replyTargetId: post.sharedPostId ?? post.id },
      orderBy: { published: "asc" },
    });
    replies = replies.filter((reply) =>
      isPostVisibleTo(reply, ctx.state.account?.actor)
    );
    const content = await renderMarkup(db, ctx.state.fedCtx, post.contentHtml, {
      kv,
      docId: post.id,
    });
    const author = post.actor.name ?? post.actor.handle;
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
      {
        name: "fediverse:creator",
        content: post.actor.handle.replace(/^@/, ""),
      },
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
      actor: Actor & {
        followers: Following[];
        blockees: Blocking[];
        blockers: Blocking[];
      };
      replyTarget: Post & { actor: Actor } | null;
      mentions: Mention[];
    };
    if (ctx.params.username.includes("@")) {
      if (ctx.params.username.endsWith(`@${ctx.url.host}`)) {
        return ctx.redirect(`/@${ctx.params.username}/${id}`);
      }
      const result = await getPostByUsernameAndId(
        db,
        ctx.params.username,
        id,
        ctx.state.account,
      );
      if (result == null) return ctx.next();
      post = result;
    } else {
      const note = await getNoteSource(
        db,
        ctx.params.username,
        id,
        ctx.state.account,
      );
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
    const quotedPost = parsed.output.quotedPostId == null
      ? undefined
      : await db.query.postTable.findFirst({
        where: {
          id: parsed.output.quotedPostId as Uuid,
          visibility: { in: ["public", "unlisted"] },
        },
        with: { actor: true },
      });
    const reply = await createNote(db, kv, disk, ctx.state.fedCtx, {
      ...parsed.output,
      accountId: ctx.state.account.id,
    }, { replyTarget: post, quotedPost });
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
    const post: Post & { actor: Actor; replyTarget: Post | null } = {
      ...note.post,
      actor: ctx.state.account.actor,
    };
    await deletePost(db, ctx.state.fedCtx, post);
    return new Response(null, { status: 202 });
  },
});

type NotePageProps = {
  post: Post & {
    actor: Actor & { instance: Instance };
    link: PostLink & { creator?: Actor | null } | null;
    sharedPost:
      | Post & {
        actor: Actor & { instance: Instance };
        link: PostLink & { creator?: Actor | null } | null;
        replyTarget:
          | Post & {
            actor: Actor & {
              instance: Instance;
              followers: Following[];
              blockees: Blocking[];
              blockers: Blocking[];
            };
            link: PostLink & { creator?: Actor | null } | null;
            mentions: (Mention & { actor: Actor })[];
            media: PostMedium[];
          }
          | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
        shares: Post[];
        reactions: Reaction[];
      }
      | null;
    replyTarget:
      | Post & {
        actor: Actor & {
          instance: Instance;
          followers: Following[];
          blockees: Blocking[];
          blockers: Blocking[];
        };
        link: PostLink & { creator?: Actor | null } | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
      }
      | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
    reactions: Reaction[];
  };
  postUrl: string;
  replies: (Post & {
    actor: Actor;
    link: PostLink & { creator?: Actor | null } | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
    reactions: Reaction[];
  })[];
};

export default define.page<typeof handler, NotePageProps>(
  ({ state, data: { post, postUrl, replies } }) => {
    const commentTargets = post.mentions
      .filter((m) =>
        m.actorId !== post.actorId && m.actorId !== state.account?.actor.id
      )
      .map((m) => m.actor.handle);
    if (
      !commentTargets.includes(post.actor.handle) &&
      state.account?.actor.id !== post.actorId
    ) {
      commentTargets.unshift(post.actor.handle);
    }
    return (
      <>
        <PostExcerpt post={post} noControls signedAccount={state.account} />
        <PostControls
          class="mt-4 ml-14"
          language={state.language}
          post={post}
          active="reply"
          signedAccount={state.account}
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
              commentTargets={commentTargets}
              textAreaId="reply"
              onPost="reload"
              defaultVisibility={post.visibility}
            />
          )}
        {replies.map((reply) => (
          <>
            <NoteExcerpt post={reply} />
            <PostControls
              class="mt-4 ml-14"
              language={state.language}
              post={reply}
              signedAccount={state.account}
            />
          </>
        ))}
      </>
    );
  },
);
