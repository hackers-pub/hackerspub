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
// Following a deep link auto-expands the target's ancestors past
// NEWS_DISCUSSION_AUTO_DEPTH, but only down to this depth and only this many
// reply pages per node, so a hash link cannot fan out into fetching the entire
// tree at once.
const NEWS_DISCUSSION_TARGET_MAX_DEPTH = 8;
const NEWS_DISCUSSION_TARGET_MAX_PAGES = 5;

const childrenQuery = graphql`
  query NewsDiscussionThreadChildrenQuery(
    $id: ID!
    $cursor: String
    $quoteCursor: String
    $loadReplies: Boolean!
    $loadQuotes: Boolean!
  ) {
    node(id: $id) {
      ... on Post {
        replies(after: $cursor, first: 10) @include(if: $loadReplies) {
          edges { node { id ...NewsDiscussionThread_post } }
          pageInfo { hasNextPage endCursor }
        }
        quotes(after: $quoteCursor, first: 20) @include(if: $loadQuotes) {
          edges { node { id ...NewsDiscussionThread_post } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

interface Child {
  readonly id: string;
  readonly key: NewsDiscussionThread_post$key;
}

type LoadMode = "initial" | "replies" | "quotes";

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

  const [replyChildren, setReplyChildren] = createSignal<Child[]>([]);
  const [quoteChildren, setQuoteChildren] = createSignal<Child[]>([]);
  const [expanded, setExpanded] = createSignal(false);
  const [loadState, setLoadState] = createSignal<
    "idle" | "loading" | "errored"
  >("idle");
  const [replyCursor, setReplyCursor] = createSignal<string | null>(null);
  const [replyHasMore, setReplyHasMore] = createSignal(false);
  const [quoteCursor, setQuoteCursor] = createSignal<string | null>(null);
  const [quoteHasMore, setQuoteHasMore] = createSignal(false);
  // Dedup across pages and against replies that are also quotes of this post.
  const seen = new Set<string>();
  // `fetchQuery` is one-shot (next then complete), and the `loadState` guard
  // below prevents overlapping loads, so the subscription needs no manual
  // unsubscribe (unsubscribing an in-flight request throws `AbortError`).  This
  // flag just stops late callbacks from touching state after unmount.
  let disposed = false;
  // Bounds the deep-link reply auto-pagination; reset on each fresh load.
  let autoPages = 0;
  // The last load kind, so the error-retry button repeats it.
  let lastMode: LoadMode = "initial";
  onCleanup(() => disposed = true);

  const childCount = () => {
    const p = post();
    return p == null ? 0 : p.engagementStats.replies + p.engagementStats.quotes;
  };

  function loadChildren(mode: LoadMode = "initial") {
    const p = post();
    if (p == null || loadState() === "loading") return;
    lastMode = mode;
    if (mode === "initial") {
      seen.clear();
      autoPages = 0;
      setReplyChildren([]);
      setQuoteChildren([]);
      setReplyCursor(null);
      setQuoteCursor(null);
      setReplyHasMore(false);
      setQuoteHasMore(false);
    }
    setExpanded(true);
    setLoadState("loading");
    // Only fetch the connection this load touches; the other would just be
    // refetched and discarded.
    fetchQuery<NewsDiscussionThreadChildrenQuery>(
      environment(),
      childrenQuery,
      {
        id: p.id,
        cursor: mode === "replies" ? replyCursor() : null,
        quoteCursor: mode === "quotes" ? quoteCursor() : null,
        loadReplies: mode !== "quotes",
        loadQuotes: mode !== "replies",
      },
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
          // A reply that also quotes this post is collected as a reply (below,
          // first) and deduped out of the quotes, so it renders exactly once.
          let autoPaginate = false;
          if (mode !== "quotes") {
            const replies = collect(node?.replies?.edges);
            setReplyChildren((prev) =>
              mode === "replies" ? [...prev, ...replies] : replies
            );
            const nextHasMore = node?.replies?.pageInfo?.hasNextPage ?? false;
            setReplyCursor(node?.replies?.pageInfo?.endCursor ?? null);
            setReplyHasMore(nextHasMore);
            // When following a deep link, keep paginating replies so a target
            // buried on a later page is reached, but cap the depth and page
            // count so a hash link cannot fan out into the entire tree.
            autoPaginate = nextHasMore && props.targetUuid != null &&
              props.depth < NEWS_DISCUSSION_TARGET_MAX_DEPTH &&
              autoPages < NEWS_DISCUSSION_TARGET_MAX_PAGES;
          }
          if (mode !== "replies") {
            const quotes = collect(node?.quotes?.edges);
            setQuoteChildren((prev) =>
              mode === "quotes" ? [...prev, ...quotes] : quotes
            );
            setQuoteCursor(node?.quotes?.pageInfo?.endCursor ?? null);
            setQuoteHasMore(node?.quotes?.pageInfo?.hasNextPage ?? false);
          }
          setLoadState("idle");
          if (autoPaginate) {
            autoPages++;
            loadChildren("replies");
          }
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
      (props.depth < NEWS_DISCUSSION_AUTO_DEPTH ||
        (props.targetUuid != null &&
          props.depth < NEWS_DISCUSSION_TARGET_MAX_DEPTH))
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

  const engagementBase = (p: NewsDiscussionThread_post$data) => {
    if (!p.actor.local || p.url == null) return null;
    try {
      return new URL(p.url).pathname;
    } catch {
      return null;
    }
  };

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
                <For each={quoteChildren()}>
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
                <Show when={quoteHasMore()}>
                  <button
                    type="button"
                    onClick={() => loadChildren("quotes")}
                    disabled={loadState() === "loading"}
                    class="block w-full cursor-pointer px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-primary disabled:opacity-60"
                  >
                    {t`Load more quotes`}
                  </button>
                </Show>
                <For each={replyChildren()}>
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
                <Show when={replyHasMore()}>
                  <button
                    type="button"
                    onClick={() => loadChildren("replies")}
                    disabled={loadState() === "loading"}
                    class="block w-full cursor-pointer px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-primary disabled:opacity-60"
                  >
                    {t`Load more replies`}
                  </button>
                </Show>
                <Show when={loadState() === "errored"}>
                  <button
                    type="button"
                    onClick={() => loadChildren(lastMode)}
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
