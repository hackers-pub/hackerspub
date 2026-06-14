import { isArticleLike, isPostVisibleTo } from "@hackerspub/models/post";
import { isPostCensoredFor, redactCensoredPost } from "../censorship.ts";
import type {
  Account,
  Actor,
  Blocking,
  Following,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "@hackerspub/models/schema";
import { ArticleExcerpt } from "../islands/ArticleExcerpt.tsx";
import { PostControls } from "../islands/PostControls.tsx";
import { Translation } from "./Msg.tsx";
import { NoteExcerpt } from "./NoteExcerpt.tsx";

export interface PostExcerptProps {
  canonicalOrigin: string;
  class?: string;
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
  replier?: Actor | null;
  lastSharer?: Actor | null;
  sharersCount?: number;
  noControls?: boolean;
  noQuote?: boolean;
  noReplyTarget?: boolean;
  signedAccount?: Account & { actor: Actor };
}

export function PostExcerpt(props: PostExcerptProps) {
  const post = props.post.sharedPost ?? props.post;
  const sharer = props.lastSharer == null
    ? props.post.sharedPost == null ? undefined : props.post.actor
    : props.lastSharer;
  const replyTarget = post.replyTarget != null &&
      isPostVisibleTo(
        post.replyTarget,
        props.signedAccount?.actor,
      )
    ? post.replyTarget
    : null;
  return (
    <Translation>
      {(t, language) => {
        // `replyTarget` is already `null` for a parent hidden by visibility,
        // block state, or a moderation sanction (the gate above).  Redact it
        // further when the visible parent is censored.  This one sanitized
        // value is used BOTH for the rendered nested reply target AND as the
        // `replyTarget` on the post handed to islands: Fresh serializes
        // island props (PostControls/ArticleExcerpt receive the whole post)
        // into the page, so a raw hidden or censored parent would otherwise
        // leak there even though the visible render hides it.  The author and
        // moderators are exempt (`isPostCensoredFor`), matching the permalink.
        const safeReplyTarget = replyTarget == null ? null : {
          ...(isPostCensoredFor(replyTarget, props.signedAccount)
            ? redactCensoredPost(replyTarget, t)
            : replyTarget),
          // List queries also eagerly load the `quotedPost` relation, which
          // carries the quoted post's full (possibly censored or otherwise
          // hidden) content.  The UI renders quotes via QuotedPostCard from
          // `quotedPostId`, which fetches a redacted copy, so drop the raw
          // relation here: otherwise it is serialized into island props.
          quotedPost: null,
        };
        const safePost = {
          ...post,
          replyTarget: safeReplyTarget,
          quotedPost: null,
        };
        return (
          <>
            {!props.noReplyTarget && safeReplyTarget != null && (
              <PostExcerpt
                post={{
                  ...safeReplyTarget,
                  sharedPost: null,
                  replyTarget: null,
                  shares: [], // TODO: extract PostExcerpt from Post
                  reactions: [],
                }}
                replier={post.actor}
                canonicalOrigin={props.canonicalOrigin}
                signedAccount={props.signedAccount}
              />
            )}
            {isArticleLike(safePost)
              ? (
                <ArticleExcerpt
                  language={language}
                  class={props.class}
                  post={safePost}
                  sharer={sharer}
                  replier={props.replier}
                  controls
                  signedAccount={props.signedAccount}
                />
              )
              : (
                <div
                  class={safeReplyTarget?.type === "Article"
                    ? "bg-gradient-to-b from-stone-100 dark:from-stone-800 to-transparent flex flex-row p-4 pt-0 gap-4"
                    : ""}
                >
                  {safeReplyTarget?.type === "Article" && (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke-width="1.5"
                      stroke="currentColor"
                      class="size-6"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="m16.49 12 3.75 3.75m0 0-3.75 3.75m3.75-3.75H3.74V4.499"
                      />
                    </svg>
                  )}
                  <div>
                    <NoteExcerpt
                      canonicalOrigin={props.canonicalOrigin}
                      class={safeReplyTarget?.type != "Article"
                        ? `${props.class} mt-2`
                        : props.class}
                      post={safePost}
                      sharer={sharer}
                      replyTarget={props.replier != null}
                      reply={safeReplyTarget != null}
                      signedAccount={props.signedAccount}
                    />
                    {!props.replier && !props.noControls && (
                      <PostControls
                        language={language}
                        post={safePost}
                        class="mt-4 ml-14"
                        signedAccount={props.signedAccount}
                      />
                    )}
                  </div>
                </div>
              )}
          </>
        );
      }}
    </Translation>
  );
}
