import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { ActorHoverCard } from "./ActorHoverCard.tsx";
import { InternalLink } from "./InternalLink.tsx";
import type {
  PostAuthorAvatar_post$data,
  PostAuthorAvatar_post$key,
} from "./__generated__/PostAuthorAvatar_post.graphql.ts";
import type {
  PostAuthorLine_post$data,
  PostAuthorLine_post$key,
} from "./__generated__/PostAuthorLine_post.graphql.ts";
import type {
  PostAuthorText_post$data,
  PostAuthorText_post$key,
} from "./__generated__/PostAuthorText_post.graphql.ts";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";
import { cn } from "~/lib/utils.ts";

type AvatarActor = PostAuthorAvatar_post$data["actor"];
type LineActor = PostAuthorLine_post$data["actor"];
export interface PostAuthorTextData {
  readonly actor: {
    readonly rawName: string | null | undefined;
    readonly handle: string;
  };
  readonly organizationAuthor:
    | {
      readonly attributionMode: string;
      readonly member:
        | {
          readonly actor: {
            readonly rawName: string | null | undefined;
            readonly handle: string;
          };
        }
        | null
        | undefined;
    }
    | null
    | undefined;
}

type TextActor = PostAuthorTextData["actor"];

function actorHref(actor: Pick<LineActor, "iri" | "url">): string {
  return actor.url ?? actor.iri;
}

function actorInternalHref(
  actor: Pick<LineActor, "handle" | "local" | "username">,
): string {
  return actor.local ? `/@${actor.username}` : `/${actor.handle}`;
}

function isCoauthored(
  organizationAuthor:
    | {
      readonly attributionMode: string;
      readonly member: { readonly actor: unknown } | null | undefined;
    }
    | null
    | undefined,
): boolean {
  return organizationAuthor?.attributionMode === "ACTING_ACCOUNT_WITH_VIEWER" &&
    organizationAuthor.member?.actor != null;
}

function coauthorAvatarActor(
  post: PostAuthorAvatar_post$data,
): AvatarActor | null {
  return isCoauthored(post.organizationAuthor)
    ? post.organizationAuthor?.member?.actor ?? null
    : null;
}

function coauthorLineActor(post: PostAuthorLine_post$data): LineActor | null {
  return isCoauthored(post.organizationAuthor)
    ? post.organizationAuthor?.member?.actor ?? null
    : null;
}

function coauthorTextActor(post: PostAuthorTextData): TextActor | null {
  return isCoauthored(post.organizationAuthor)
    ? post.organizationAuthor?.member?.actor ?? null
    : null;
}

function displayActorName(actor: TextActor): string {
  return (actor.rawName ?? "").trim() || actor.handle;
}

export function formatPostAuthorText(post: PostAuthorTextData): string {
  const member = coauthorTextActor(post);
  if (member == null) return displayActorName(post.actor);
  return `${displayActorName(post.actor)} + ${displayActorName(member)}`;
}

export interface PostAuthorTextProps {
  $post: PostAuthorText_post$key;
}

export function PostAuthorText(props: PostAuthorTextProps) {
  const post = createFragment(
    graphql`
      fragment PostAuthorText_post on Post {
        actor {
          rawName
          handle
        }
        organizationAuthor {
          attributionMode
          member {
            actor {
              rawName
              handle
            }
          }
        }
      }
    `,
    () => props.$post,
  );

  return (
    <>
      {post() == null
        ? ""
        : formatPostAuthorText(post() as PostAuthorText_post$data)}
    </>
  );
}

export interface PostAuthorAvatarProps {
  $post: PostAuthorAvatar_post$key;
  size?: "default" | "large";
  class?: string;
}

export function PostAuthorAvatar(props: PostAuthorAvatarProps) {
  const post = createFragment(
    graphql`
      fragment PostAuthorAvatar_post on Post {
        actor {
          avatarUrl
          avatarInitials
          username
          handle
          local
          url
          iri
        }
        organizationAuthor {
          attributionMode
          member {
            actor {
              avatarUrl
              avatarInitials
              username
              handle
              local
              url
              iri
            }
          }
        }
      }
    `,
    () => props.$post,
  );

  return (
    <Show keyed when={post()}>
      {(p) => {
        const member = coauthorAvatarActor(p);
        const avatarSize = props.size === "large" ? "size-12" : "size-10";
        const badgeSize = props.size === "large" ? "size-6" : "size-5";
        return (
          <div class={cn("relative shrink-0", avatarSize, props.class)}>
            <ActorHoverCard handle={p.actor.handle} class="block size-full">
              <Avatar class={avatarSize}>
                <InternalLink
                  class="block size-full"
                  href={actorHref(p.actor)}
                  internalHref={actorInternalHref(p.actor)}
                >
                  <AvatarImage src={p.actor.avatarUrl} />
                  <AvatarFallback>{p.actor.avatarInitials}</AvatarFallback>
                </InternalLink>
              </Avatar>
            </ActorHoverCard>
            <Show keyed when={member}>
              {(m) => (
                <ActorHoverCard
                  handle={m.handle}
                  class="absolute -right-1 -bottom-1 block"
                >
                  <Avatar
                    class={cn(
                      badgeSize,
                      "border-2 border-background shadow-sm",
                    )}
                  >
                    <InternalLink
                      class="block size-full"
                      href={actorHref(m)}
                      internalHref={actorInternalHref(m)}
                    >
                      <AvatarImage src={m.avatarUrl} />
                      <AvatarFallback class="text-[0.625rem]">
                        {m.avatarInitials}
                      </AvatarFallback>
                    </InternalLink>
                  </Avatar>
                </ActorHoverCard>
              )}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

interface AuthorIdentityProps {
  actor: LineActor;
  class?: string;
  nameClass?: string;
  handleClass?: string;
}

function AuthorIdentity(props: AuthorIdentityProps) {
  return (
    <ActorHoverCard
      handle={props.actor.handle}
      class={cn(
        "inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-1",
        props.class,
      )}
    >
      <Show when={(props.actor.name ?? "").trim() !== ""}>
        <InternalLink
          href={actorHref(props.actor)}
          internalHref={actorInternalHref(props.actor)}
          innerHTML={props.actor.name ?? ""}
          class={cn("min-w-0 truncate font-semibold", props.nameClass)}
        />
      </Show>
      <span
        class={cn(
          "min-w-0 truncate select-all text-muted-foreground",
          props.handleClass,
        )}
        title={props.actor.handle}
      >
        {props.actor.handle}
      </span>
    </ActorHoverCard>
  );
}

export interface PostAuthorLineProps {
  $post: PostAuthorLine_post$key;
  class?: string;
  nameClass?: string;
  handleClass?: string;
}

export function PostAuthorLine(props: PostAuthorLineProps) {
  const post = createFragment(
    graphql`
      fragment PostAuthorLine_post on Post {
        actor {
          name
          handle
          username
          local
          url
          iri
        }
        organizationAuthor {
          attributionMode
          member {
            actor {
              name
              handle
              username
              local
              url
              iri
            }
          }
        }
      }
    `,
    () => props.$post,
  );

  return (
    <Show keyed when={post()}>
      {(p) => (
        <div
          class={cn(
            "flex min-w-0 flex-wrap items-baseline gap-x-1",
            props.class,
          )}
        >
          <AuthorIdentity
            actor={p.actor}
            nameClass={props.nameClass}
            handleClass={props.handleClass}
          />
          <Show keyed when={coauthorLineActor(p)}>
            {(member) => (
              <>
                <span
                  aria-hidden="true"
                  class="shrink-0 text-muted-foreground/60"
                >
                  +
                </span>
                <AuthorIdentity
                  actor={member}
                  nameClass={props.nameClass}
                  handleClass={props.handleClass}
                />
              </>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
