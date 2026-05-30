import { fetchQuery, graphql } from "relay-runtime";
import {
  createMemo,
  createSignal,
  For,
  getOwner,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
} from "solid-js";
import { createFragment, useRelayEnvironment } from "solid-relay";
import { ActorHoverCard } from "~/components/ActorHoverCard.tsx";
import { InternalLink } from "~/components/InternalLink.tsx";
import { PostAvatar } from "~/components/PostAvatar.tsx";
import { PostEngagementBar } from "~/components/PostEngagementBar.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useContentLinkInterceptor } from "~/lib/contentLinkInterceptor.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { useMentionHoverCards } from "~/lib/mentionHoverCards.tsx";
import type {
  NewsDiscussionThread_post$data,
  NewsDiscussionThread_post$key,
} from "./__generated__/NewsDiscussionThread_post.graphql.ts";
import type { NewsDiscussionThreadChildrenQuery } from "./__generated__/NewsDiscussionThreadChildrenQuery.graphql.ts";

// Auto-expand replies/quotes down to this depth; deeper levels load only when
// the reader asks (so a busy thread does not fetch everything up front).
export const NEWS_DISCUSSION_AUTO_DEPTH = 3;

const childrenQuery = graphql`
  query NewsDiscussionThreadChildrenQuery($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on Post {
        replies(after: $cursor, first: 10) {
          edges { node { id ...NewsDiscussionThread_post } }
          pageInfo { hasNextPage endCursor }
        }
        quotes(first: 20) {
          edges { node { id ...NewsDiscussionThread_post } }
        }
      }
    }
  }
`;

interface Child {
  readonly id: string;
  readonly key: NewsDiscussionThread_post$key;
}

export interface NewsDiscussionThreadProps {
  $post: NewsDiscussionThread_post$key;
  depth: number;
  /** UUID from the URL hash; ancestors of it auto-expand and it is scrolled to. */
  targetUuid?: string | null;
  /** Post ids already rendered up the ancestor chain, to break cycles. */
  visited?: ReadonlySet<string>;
  /**
   * Discussion-wide set of post ids already rendered anywhere in the tree.  A
   * post can legitimately be both a root sharing post and a reply/quote under
   * another post (or a child of two branches); this set ensures each renders in
   * exactly one place, so there are no duplicate `post-<uuid>` anchors.  The
   * first node to claim an id wins; it releases the claim on unmount.
   */
  rendered: Set<string>;
}

export function NewsDiscussionThread(props: NewsDiscussionThreadProps) {
  const { t } = useLingui();
  const { onNoteCreated } = useNoteCompose();
  const environment = useRelayEnvironment();
  const owner = getOwner();
  const post = createFragment(
    graphql`
      fragment NewsDiscussionThread_post on Post {
        id
        uuid
        content
        language
        url
        iri
        published
        engagementStats {
          replies
          quotes
        }
        actor {
          name
          handle
          username
          local
          url
          iri
          ...PostAvatar_actor
        }
        ...PostEngagementBar_post
      }
    `,
    () => props.$post,
  );

  // Claim this post id for the whole discussion (synchronously, before render):
  // a duplicate occurrence elsewhere in the tree renders nothing.  Released on
  // unmount so a reload/refetch of the same post can re-claim it.
  const ownId = post()?.id;
  if (ownId != null) {
    if (props.rendered.has(ownId)) return null;
    props.rendered.add(ownId);
    onCleanup(() => props.rendered.delete(ownId));
  }

  const [children, setChildren] = createSignal<Child[]>([]);
  const [expanded, setExpanded] = createSignal(false);
  const [loadState, setLoadState] = createSignal<
    "idle" | "loading" | "errored"
  >("idle");
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [hasMore, setHasMore] = createSignal(false);
  // Dedup across pages and against replies that are also quotes of this post.
  const seen = new Set<string>();
  // `fetchQuery` is one-shot (next then complete), and the `loadState` guard
  // below prevents overlapping loads, so the subscription needs no manual
  // unsubscribe (unsubscribing an in-flight request throws `AbortError`).  This
  // flag just stops late callbacks from touching state after unmount.
  let disposed = false;
  onCleanup(() => disposed = true);

  const childCount = () => {
    const p = post();
    return p == null ? 0 : p.engagementStats.replies + p.engagementStats.quotes;
  };

  function loadChildren(more = false) {
    const p = post();
    if (p == null || loadState() === "loading") return;
    if (!more) {
      seen.clear();
      setChildren([]);
      setCursor(null);
    }
    setExpanded(true);
    setLoadState("loading");
    fetchQuery<NewsDiscussionThreadChildrenQuery>(
      environment(),
      childrenQuery,
      { id: p.id, cursor: more ? cursor() : null },
    ).subscribe({
      next(data) {
        if (disposed) return;
        runWithOwner(owner, () => {
          const node = data.node;
          const collect = (
            edges:
              | ReadonlyArray<{ node: { id: string } & Child["key"] } | null>
              | null
              | undefined,
          ): Child[] => {
            const out: Child[] = [];
            for (const edge of edges ?? []) {
              const n = edge?.node;
              if (n == null) continue;
              if (n.id === p.id) continue; // never re-render self
              if (props.visited?.has(n.id)) continue; // ancestor already shows it
              if (seen.has(n.id)) continue; // already loaded under this node
              seen.add(n.id);
              out.push({ id: n.id, key: n });
            }
            return out;
          };
          const replies = collect(node?.replies?.edges);
          // Quotes are unpaginated (first 20); only collect them once.
          const quotes = more ? [] : collect(node?.quotes?.edges);
          setChildren((prev) =>
            more ? [...prev, ...replies] : [...quotes, ...replies]
          );
          const nextHasMore = node?.replies?.pageInfo?.hasNextPage ?? false;
          setCursor(node?.replies?.pageInfo?.endCursor ?? null);
          setHasMore(nextHasMore);
          setLoadState("idle");
          // When following a deep link, keep paginating so a target buried on a
          // later reply page is reached and can be scrolled to.
          if (nextHasMore && props.targetUuid != null) loadChildren(true);
        });
      },
      error() {
        if (disposed) return;
        runWithOwner(owner, () => setLoadState("errored"));
      },
    });
  }

  onMount(() => {
    // Refresh this node's loaded children when the viewer composes a reply.
    onCleanup(onNoteCreated(() => {
      if (expanded()) loadChildren();
    }));
    if (
      childCount() > 0 &&
      (props.depth < NEWS_DISCUSSION_AUTO_DEPTH || props.targetUuid != null)
    ) {
      loadChildren();
    }
  });

  const isTarget = createMemo(() =>
    props.targetUuid != null && post()?.uuid === props.targetUuid
  );
  const childVisited = createMemo(() => {
    const p = post();
    const set = new Set(props.visited ?? []);
    if (p != null) set.add(p.id);
    return set;
  });

  let articleRef: HTMLElement | undefined;
  onMount(() => {
    if (isTarget() && articleRef != null) {
      requestAnimationFrame(() =>
        articleRef?.scrollIntoView({ block: "center" })
      );
    }
  });

  const [proseRef, setProseRef] = createSignal<HTMLElement>();
  useMentionHoverCards(proseRef);
  useContentLinkInterceptor(proseRef);

  const engagementBase = (p: NewsDiscussionThread_post$data) =>
    p.actor.local && p.url != null ? new URL(p.url).pathname : null;

  return (
    <Show keyed when={post()}>
      {(p) => (
        <div
          class="border-l"
          classList={{ "border-transparent": props.depth === 0 }}
        >
          <article
            ref={articleRef}
            id={`post-${p.uuid}`}
            class="scroll-mt-20 px-4 py-3 transition-colors"
            classList={{
              "bg-info/10": isTarget(),
              "hover:bg-muted/30": !isTarget(),
              "pl-4 sm:pl-6": props.depth > 0,
            }}
          >
            <div class="flex gap-3">
              <PostAvatar $actor={p.actor} />
              <div class="min-w-0 grow">
                <div class="flex min-w-0 flex-wrap items-baseline gap-x-1">
                  <ActorHoverCard
                    handle={p.actor.handle}
                    class="flex min-w-0 flex-wrap items-baseline gap-x-1"
                  >
                    <Show when={(p.actor.name ?? "").trim() !== ""}>
                      <InternalLink
                        href={p.actor.url ?? p.actor.iri}
                        internalHref={p.actor.local
                          ? `/@${p.actor.username}`
                          : `/${p.actor.handle}`}
                        innerHTML={p.actor.name ?? ""}
                        class="font-semibold"
                      />
                    </Show>
                    <span
                      class="min-w-0 truncate text-sm select-all text-muted-foreground"
                      title={p.actor.handle}
                    >
                      {p.actor.handle}
                    </span>
                  </ActorHoverCard>
                  <a
                    href={p.url ?? p.iri}
                    class="text-sm text-muted-foreground/70 hover:underline"
                  >
                    <Timestamp value={p.published} />
                  </a>
                </div>
                <div
                  ref={setProseRef}
                  innerHTML={p.content}
                  lang={p.language ?? undefined}
                  class="prose dark:prose-invert mt-1 max-w-none break-words"
                />
                <PostEngagementBar
                  $post={p}
                  repliesHref={null}
                  engagementBase={engagementBase(p)}
                  class="mt-1"
                />
              </div>
            </div>
          </article>

          <Show when={childCount() > 0}>
            <div class="ml-4 sm:ml-6">
              <Show
                when={expanded()}
                fallback={
                  <button
                    type="button"
                    onClick={() => loadChildren()}
                    class="block w-full cursor-pointer px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-primary"
                  >
                    {t`Show ${childCount()} more in this thread`}
                  </button>
                }
              >
                <For each={children()}>
                  {(child) => (
                    <NewsDiscussionThread
                      $post={child.key}
                      depth={props.depth + 1}
                      targetUuid={props.targetUuid}
                      visited={childVisited()}
                      rendered={props.rendered}
                    />
                  )}
                </For>
                <Show when={hasMore()}>
                  <button
                    type="button"
                    onClick={() => loadChildren(true)}
                    disabled={loadState() === "loading"}
                    class="block w-full cursor-pointer px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-primary disabled:opacity-60"
                  >
                    {t`Load more replies`}
                  </button>
                </Show>
                <Show when={loadState() === "errored"}>
                  <button
                    type="button"
                    onClick={() => loadChildren(cursor() != null)}
                    class="block w-full cursor-pointer px-4 py-2 text-left text-sm text-error transition-colors hover:underline"
                  >
                    {t`Failed to load replies; click to retry`}
                  </button>
                </Show>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
