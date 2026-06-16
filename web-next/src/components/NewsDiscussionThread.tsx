import { fetchQuery, graphql } from "relay-runtime";
import {
  createMemo,
  createSignal,
  For,
  getOwner,
  Match,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  Switch,
} from "solid-js";
import { createFragment, useRelayEnvironment } from "solid-relay";
import { ActorHoverCard } from "~/components/ActorHoverCard.tsx";
import { InternalLink } from "~/components/InternalLink.tsx";
import { PostAvatar } from "~/components/PostAvatar.tsx";
import { PostEngagementBar } from "~/components/PostEngagementBar.tsx";
import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
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
  /**
   * The discussion's root connection (`NewsDiscussion__sharingPosts`), so
   * deleting a post that is an edge of it removes that edge via `@deleteEdge`.
   * Forwarded unchanged to children: reply/quote children are normally removed
   * from local signals via `onDeleted`, but a post can be both a root sharing
   * post and a reply/quote (rendered in whichever place claims it first), so a
   * child delete must also prune the root edge or the post would resurface as a
   * root.  `@deleteEdge` is a no-op for a child that has no root edge.
   */
  connections?: string[];
  /**
   * Called after this post is deleted, so the parent can drop it from its
   * locally fetched reply/quote signals (children are not Relay connections,
   * so `@deleteEdge` cannot reach them).
   */
  onDeleted?: () => void;
}

export function NewsDiscussionThread(props: NewsDiscussionThreadProps) {
  const { t } = useLingui();
  const { onNoteCreated, openForEdit } = useNoteCompose();
  const environment = useRelayEnvironment();
  const owner = getOwner();
  const post = createFragment(
    graphql`
      fragment NewsDiscussionThread_post on Post {
        id
        __typename
        uuid
        content
        language
        url
        iri
        published
        visibility
        ... on Note {
          rawContent
          quotePolicy
        }
        ... on Article {
          name
          excerptHtml(maxChars: 700)
        }
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
          isViewer
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
  // Bounds the deep-link auto-pagination per connection; reset on each fresh
  // load.
  let autoReplyPages = 0;
  let autoQuotePages = 0;
  // The last load kind, so the error-retry button repeats it.
  let lastMode: LoadMode = "initial";
  onCleanup(() => disposed = true);

  const childCount = () => {
    const p = post();
    return p == null ? 0 : p.engagementStats.replies + p.engagementStats.quotes;
  };

  // Drop a deleted child from the locally fetched reply/quote signals; its
  // subtree unmounts and releases its `rendered` claim.
  const removeChild = (id: string) => {
    seen.delete(id);
    setReplyChildren((prev) => prev.filter((c) => c.id !== id));
    setQuoteChildren((prev) => prev.filter((c) => c.id !== id));
  };

  function loadChildren(mode: LoadMode = "initial") {
    const p = post();
    if (p == null || loadState() === "loading") return;
    lastMode = mode;
    if (mode === "initial") {
      seen.clear();
      autoReplyPages = 0;
      autoQuotePages = 0;
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
          if (mode !== "quotes") {
            const replies = collect(node?.replies?.edges);
            setReplyChildren((prev) =>
              mode === "replies" ? [...prev, ...replies] : replies
            );
            setReplyCursor(node?.replies?.pageInfo?.endCursor ?? null);
            setReplyHasMore(node?.replies?.pageInfo?.hasNextPage ?? false);
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
          maybeAutoPaginate();
        });
      },
      error() {
        if (disposed) return;
        runWithOwner(owner, () => setLoadState("errored"));
      },
    });
  }

  // While following a deep link, keep paginating toward the buried target one
  // connection at a time (replies first, then quotes), each capped by page
  // count and by depth so the expansion stays bounded.  A deep-linked quote
  // past the first page is reached this way, not just a deep-linked reply.
  function maybeAutoPaginate() {
    if (
      props.targetUuid == null ||
      props.depth >= NEWS_DISCUSSION_TARGET_MAX_DEPTH
    ) {
      return;
    }
    if (replyHasMore() && autoReplyPages < NEWS_DISCUSSION_TARGET_MAX_PAGES) {
      autoReplyPages++;
      loadChildren("replies");
    } else if (
      quoteHasMore() && autoQuotePages < NEWS_DISCUSSION_TARGET_MAX_PAGES
    ) {
      autoQuotePages++;
      loadChildren("quotes");
    }
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
                <Switch
                  fallback={
                    <div
                      ref={setProseRef}
                      innerHTML={p.content}
                      lang={p.language ?? undefined}
                      class="prose dark:prose-invert mt-1 max-w-none break-words"
                    />
                  }
                >
                  <Match when={p.__typename === "Article"}>
                    <div class="mt-1">
                      <Show keyed when={p.name}>
                        {(name) => (
                          <h3 class="text-base font-semibold leading-snug">
                            <a href={p.url ?? p.iri} class="hover:underline">
                              {name}
                            </a>
                          </h3>
                        )}
                      </Show>
                      <div
                        ref={setProseRef}
                        innerHTML={p.excerptHtml}
                        lang={p.language ?? undefined}
                        class="prose dark:prose-invert mt-1 line-clamp-4 max-w-none break-words text-sm text-muted-foreground"
                      />
                      <a
                        href={p.url ?? p.iri}
                        class="mt-2 inline-block text-sm font-medium text-primary hover:underline"
                      >
                        {t`Read full article`}
                      </a>
                    </div>
                  </Match>
                </Switch>
                <PostEngagementBar
                  $post={p}
                  repliesHref={null}
                  engagementBase={engagementBase(p)}
                  connections={props.connections ?? []}
                  onDeleted={props.onDeleted}
                  onEdit={p.rawContent != null && p.visibility !== "NONE"
                    ? () =>
                      openForEdit(p.id, {
                        content: p.rawContent!,
                        language: p.language,
                        quotePolicy: (p.quotePolicy as QuotePolicy) ??
                          "EVERYONE",
                        visibility: (p.visibility as PostVisibility) ??
                          "PUBLIC",
                      })
                    : undefined}
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
                      connections={props.connections}
                      onDeleted={() => removeChild(child.id)}
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
                      connections={props.connections}
                      onDeleted={() => removeChild(child.id)}
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
