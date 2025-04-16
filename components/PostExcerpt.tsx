import { PostControls } from "../islands/PostControls.tsx";
import { isArticleLike, isPostVisibleTo } from "../models/post.ts";
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
} from "../models/schema.ts";
import { ArticleExcerpt } from "./ArticleExcerpt.tsx";
import { Translation } from "./Msg.tsx";
import { NoteExcerpt } from "./NoteExcerpt.tsx";

export interface PostExcerptProps {
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
      {(_, language) => (
        <>
          {replyTarget != null &&
            isPostVisibleTo(replyTarget, props.signedAccount?.actor) && (
            <PostExcerpt
              post={{
                ...replyTarget,
                sharedPost: null,
                replyTarget: null,
                shares: [], // TODO: extract PostExcerpt from Post
                reactions: [],
              }}
              replier={post.actor}
            />
          )}
          {isArticleLike(post)
            ? (
              <ArticleExcerpt
                class={props.class}
                post={post}
                sharer={sharer}
                replier={props.replier}
                controls
                signedAccount={props.signedAccount}
              />
            )
            : (
              <div
                class={replyTarget?.type === "Article"
                  ? "bg-gradient-to-b from-stone-100 dark:from-stone-800 to-transparent flex flex-row p-4 pt-0 gap-4"
                  : ""}
              >
                {replyTarget?.type === "Article" && (
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
                    class={replyTarget?.type != "Article"
                      ? `${props.class} mt-2`
                      : props.class}
                    post={post}
                    sharer={sharer}
                    replyTarget={props.replier != null}
                    reply={replyTarget != null}
                    signedAccount={props.signedAccount}
                  />
                  {!props.replier && !props.noControls && (
                    <PostControls
                      language={language}
                      post={post}
                      class="mt-4 ml-14"
                      signedAccount={props.signedAccount}
                    />
                  )}
                </div>
              </div>
            )}
        </>
      )}
    </Translation>
  );
}
