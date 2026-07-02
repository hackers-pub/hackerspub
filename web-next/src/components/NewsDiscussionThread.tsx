import { Key } from "@solid-primitives/keyed";
import { fetchQuery, graphql } from "relay-runtime";
import {
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  Match,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  Switch,
} from "solid-js";
import { createFragment, useRelayEnvironment } from "solid-relay";
import { PostAuthorAvatar, PostAuthorLine } from "~/components/PostAuthor.tsx";
import { PostEngagementBar } from "~/components/PostEngagementBar.tsx";
import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useContentLinkInterceptor } from "~/lib/contentLinkInterceptor.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { useMentionHoverCards } from "~/lib/mentionHoverCards.tsx";
import type {
  NewsDiscussionThread_post$data,
  NewsDiscussionThread_post$key,
} from "./__generated__/NewsDiscussionThread_post.graphql.ts";
import type { NewsDiscussionThreadChildrenQuery } from "./__generated__/NewsDiscussionThreadChildrenQuery.graphql.ts";
import type { NewsDiscussionThreadSubtreeQuery } from "./__generated__/NewsDiscussionThreadSubtreeQuery.graphql.ts";

// Auto-expand quotes down to this depth; deeper levels load only when the
// reader asks.  Replies need no such gate: they arrive in bulk, one query
// per subtree root, via `descendants`.
export const NEWS_DISCUSSION_AUTO_DEPTH = 3;
// Following a deep link auto-expands quotes past NEWS_DISCUSSION_AUTO_DEPTH,
// but only down to this depth and only this many pages per connection, so a
// hash link cannot fan out into fetching the entire tree at once.  The same
// page bound applies to chasing the target through reply pages.
const NEWS_DISCUSSION_TARGET_MAX_DEPTH = 8;
const NEWS_DISCUSSION_TARGET_MAX_PAGES = 5;

// One fetch per subtree root (a sharing post or a quote) brings its whole
// reply tree, flattened depth-first; the previous architecture fetched every
// node's direct replies separately, which made busy threads fire dozens of
// requests.  This stays a standalone query rather than a field nested in the
// discussion's roots query: the roots query is already near the server's
// structural complexity limit, and nesting the tree under 20 root nodes
// would push it over.
const subtreeQuery = graphql`
  query NewsDiscussionThreadSubtreeQuery(
    $id: ID!
    $cursor: String
    $actingAccountId: ID
  ) {
    node(id: $id) {
      ... on Post {
        descendants(after: $cursor, first: 60, actingAccountId: $actingAccountId) {
          edges {
            node {
              id
              uuid
              replyTarget(actingAccountId: $actingAccountId) {
                id
              }
              ...NewsDiscussionThread_post @arguments(
                actingAccountId: $actingAccountId
              )
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

// Quotes are not part of the reply graph, so they stay per-node and lazy;
// this only ever runs for nodes whose cached quote counter is nonzero.
const quotesQuery = graphql`
  query NewsDiscussionThreadChildrenQuery(
    $id: ID!
    $quoteCursor: String
    $actingAccountId: ID
  ) {
    node(id: $id) {
      ... on Post {
        quotes(
          after: $quoteCursor
          first: 20
          actingAccountId: $actingAccountId
        ) {
          edges {
            node {
              id
              ...NewsDiscussionThread_post @arguments(
                actingAccountId: $actingAccountId
              )
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const threadPostFragment = graphql`
  fragment NewsDiscussionThread_post on Post
    @argumentDefinitions(actingAccountId: { type: "ID", defaultValue: null })
  {
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
      personalRawContent: rawContent
      rawContent(actingAccountId: $actingAccountId)
      quotePolicy
    }
    ... on Article {
      name
      excerptHtml(maxChars: 700)
    }
    engagementStats {
      quotes
    }
    hasVisibleReplies(actingAccountId: $actingAccountId)
    hasVisibleQuotes(actingAccountId: $actingAccountId)
    actor {
      id
      name
      handle
      username
      local
      url
      iri
      isViewer(actingAccountId: $actingAccountId)
      account {
        id
        kind
      }
    }
    ...PostAuthorAvatar_post
    ...PostAuthorLine_post
    ...PostEngagementBar_post @arguments(
      actingAccountId: $actingAccountId
    )
  }
`;

interface SubtreeReplyNode {
  readonly id: string;
  readonly uuid: string;
  readonly parentId: string;
  readonly key: NewsDiscussionThread_post$key;
}

interface QuoteChild {
  readonly id: string;
  readonly key: NewsDiscussionThread_post$key;
}

export interface NewsDiscussionSubtreeProps {
  $post: NewsDiscussionThread_post$key;
  depth: number;
  /** UUID from the URL hash; the tree auto-expands toward it. */
  targetUuid?: string | null;
  /** Post ids already rendered up the ancestor chain, to break cycles. */
  visited?: ReadonlySet<string>;
  /**
   * Discussion-wide set of post ids already rendered anywhere in the tree.
   * See {@link NewsDiscussionThreadProps.rendered}.
   */
  rendered: Set<string>;
  /** Relay connection ids to prune on deletion (the discussion's roots). */
  connections?: string[];
  /** Called after this subtree's root post is deleted. */
  onDeleted?: () => void;
}

/**
 * A discussion subtree root (a sharing post or a quote): renders the root
 * row plus its whole reply tree, loaded in bulk from the root's
 * `descendants` with "load more" continuing the server's depth-first
 * traversal.
 */
export function NewsDiscussionSubtree(props: NewsDiscussionSubtreeProps) {
  const { t } = useLingui();
  const { onNoteCreated, replyTargetId } = useNoteCompose();
  const environment = useRelayEnvironment();
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const owner = getOwner();
  const post = createFragment(threadPostFragment, () => props.$post);

  // A duplicate occurrence elsewhere in the discussion renders nothing (its
  // row would lose the `rendered` claim anyway), so don't fetch its subtree
  // either.  Same synchronous check the row component makes before claiming.
  const ownId = post()?.id;
  if (ownId != null && props.rendered.has(ownId)) return null;

  const [nodes, setNodes] = createSignal<SubtreeReplyNode[]>([]);
  const [hasMore, setHasMore] = createSignal(false);
  const [endCursor, setEndCursor] = createSignal<string | null>(null);
  const [loadState, setLoadState] = createSignal<
    "idle" | "loading" | "errored"
  >("idle");
  // Flips true after the first successful page and never resets.  Only then is
  // "no more pages" meaningful: before it (SSR, pre-mount, the initial fetch,
  // or an initial error) a missing reply is "not fetched yet", not "cut off by
  // the server's depth cap", so the continuation link must stay hidden.
  const [loaded, setLoaded] = createSignal(false);
  // Dedup across pages; reset on each fresh load.
  const seen = new Set<string>();
  let disposed = false;
  // A reload requested while a fetch is in flight runs after it settles, so
  // a reply composed mid-load is not silently dropped.
  let reloadQueued = false;
  onCleanup(() => disposed = true);

  // The subtree's reply pagination counts as exhausted only once a load has
  // succeeded, nothing is in flight, and no more pages remain.  A node with no
  // loaded replies is treated as capped (and offered a continuation link) only
  // then; otherwise it is simply awaiting a page.
  const subtreeMayContinue = () =>
    !loaded() || loadState() !== "idle" || hasMore();

  function loadReplies(mode: "initial" | "more" = "initial") {
    const p = post();
    if (p == null) return;
    if (loadState() === "loading") {
      if (mode === "initial") reloadQueued = true;
      return;
    }
    if (mode === "initial") {
      seen.clear();
      setNodes([]);
      setEndCursor(null);
      setHasMore(false);
    }
    setLoadState("loading");
    fetchQuery<NewsDiscussionThreadSubtreeQuery>(
      environment(),
      subtreeQuery,
      {
        id: p.id,
        cursor: mode === "more" ? endCursor() : null,
        actingAccountId: actingAccountId() ?? null,
      },
    ).subscribe({
      next(data) {
        if (disposed) return;
        runWithOwner(owner, () => {
          const descendants = data.node?.descendants;
          const page: SubtreeReplyNode[] = [];
          for (const edge of descendants?.edges ?? []) {
            const n = edge?.node;
            if (n == null || n.replyTarget == null) continue;
            if (n.id === p.id) continue;
            if (seen.has(n.id)) continue;
            seen.add(n.id);
            page.push({
              id: n.id,
              uuid: n.uuid,
              parentId: n.replyTarget.id,
              key: n,
            });
          }
          setNodes((prev) => mode === "more" ? [...prev, ...page] : page);
          setEndCursor(descendants?.pageInfo?.endCursor ?? null);
          setHasMore(descendants?.pageInfo?.hasNextPage ?? false);
          setLoaded(true);
          setLoadState("idle");
          if (reloadQueued) {
            reloadQueued = false;
            loadReplies();
          }
        });
      },
      error() {
        if (disposed) return;
        runWithOwner(owner, () => {
          setLoadState("errored");
          reloadQueued = false;
        });
      },
    });
  }

  // The server guarantees a parent appears before its replies, so the tree
  // rebuilds from `replyTarget` ids alone.
  const repliesByParent = createMemo(() => {
    const map = new Map<string, SubtreeReplyNode[]>();
    for (const node of nodes()) {
      let bucket = map.get(node.parentId);
      if (bucket == null) {
        bucket = [];
        map.set(node.parentId, bucket);
      }
      bucket.push(node);
    }
    return map;
  });

  const removeReply = (id: string) => {
    // Prune the whole subtree of the removed node, not just the node: its
    // descendants would otherwise linger in `nodes` (never rendered, their
    // parent chain is gone) and stay deduped in `seen`.
    setNodes((prev) => {
      const removed = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const node of prev) {
          if (removed.has(node.parentId) && !removed.has(node.id)) {
            removed.add(node.id);
            grew = true;
          }
        }
      }
      for (const node of removed) seen.delete(node);
      return prev.filter((node) => !removed.has(node.id));
    });
  };

  onMount(() => {
    if (post()?.hasVisibleReplies) loadReplies();
    // Composing a reply to a post inside this subtree refreshes just this
    // subtree.  `notifyNoteCreated` fires before the compose modal resets
    // its state, so the reply target is still readable here.
    onCleanup(onNoteCreated(() => {
      const parentId = replyTargetId();
      if (parentId == null) return;
      if (
        parentId !== post()?.id &&
        !nodes().some((node) => node.id === parentId)
      ) return;
      loadReplies();
    }));
  });

  // Following a deep link into a reply page that is not loaded yet: keep
  // loading more pages toward the target, bounded per target.
  let targetPages = 0;
  let lastTarget: string | null = null;
  createEffect(() => {
    const target = props.targetUuid ?? null;
    if (target !== lastTarget) {
      lastTarget = target;
      targetPages = 0;
    }
    if (target == null || targetPages >= NEWS_DISCUSSION_TARGET_MAX_PAGES) {
      return;
    }
    if (nodes().some((node) => node.uuid === target)) return;
    if (!hasMore() || loadState() !== "idle") return;
    targetPages++;
    loadReplies("more");
  });

  return (
    <>
      <NewsDiscussionThread
        $post={props.$post}
        depth={props.depth}
        targetUuid={props.targetUuid}
        visited={props.visited}
        rendered={props.rendered}
        connections={props.connections}
        onDeleted={props.onDeleted}
        repliesOf={(id) => repliesByParent().get(id) ?? []}
        onReplyDeleted={removeReply}
        subtreeMayContinue={subtreeMayContinue()}
      />
      <Show when={hasMore()}>
        <button
          type="button"
          onClick={() => loadReplies("more")}
          disabled={loadState() === "loading"}
          class="block w-full cursor-pointer px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-primary disabled:opacity-60"
          classList={{ "pl-8 sm:pl-10": props.depth > 0 }}
        >
          {loadState() === "loading"
            ? t`Loading more replies…`
            : t`Load more replies`}
        </button>
      </Show>
      <Show when={loadState() === "errored"}>
        <button
          type="button"
          onClick={() => loadReplies(nodes().length > 0 ? "more" : "initial")}
          class="block w-full cursor-pointer px-4 py-2 text-left text-sm text-error transition-colors hover:underline"
          classList={{ "pl-8 sm:pl-10": props.depth > 0 }}
        >
          {t`Failed to load replies; click to retry`}
        </button>
      </Show>
    </>
  );
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
  /**
   * The discussion's root connection (`NewsDiscussion__sharingPosts`), so
   * deleting a post that is an edge of it removes that edge via `@deleteEdge`.
   * Forwarded unchanged to children: reply/quote children are removed from
   * local state via their own callbacks, but a post can be both a root
   * sharing post and a reply/quote (rendered in whichever place claims it
   * first), so a child delete must also prune the root edge or the post
   * would resurface as a root.  `@deleteEdge` is a no-op for a child that
   * has no root edge.
   */
  connections?: string[];
  /**
   * Called after this post is deleted, so the owner can drop it from its
   * local state (the enclosing subtree's reply list, or the parent node's
   * quote list).
   */
  onDeleted?: () => void;
  /**
   * Replies below the enclosing subtree's root, keyed by parent post id.
   * Populated in bulk from the subtree root's `descendants`; reply rows
   * recurse with the same accessor.
   */
  repliesOf: (id: string) => readonly SubtreeReplyNode[];
  /** Bubbles a deleted reply up to the subtree owning the reply list. */
  onReplyDeleted?: (id: string) => void;
  /**
   * Whether the enclosing subtree's `descendants` pagination may still load
   * more replies.  While it can, a node with no loaded replies is just "not
   * fetched yet"; once the connection is exhausted, a node that still reports
   * replies but has none loaded was cut off by the server's depth cap (or is
   * not fully federated), so it links to its own permalink to continue there.
   */
  subtreeMayContinue: boolean;
}

export function NewsDiscussionThread(props: NewsDiscussionThreadProps) {
  const { t } = useLingui();
  const { onNoteCreated, openForEdit, quotedPostId } = useNoteCompose();
  const environment = useRelayEnvironment();
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const owner = getOwner();
  const post = createFragment(threadPostFragment, () => props.$post);

  // Claim this post id for the whole discussion (synchronously, before render):
  // a duplicate occurrence elsewhere in the tree renders nothing.  Released on
  // unmount so a reload/refetch of the same post can re-claim it.
  const ownId = post()?.id;
  if (ownId != null) {
    if (props.rendered.has(ownId)) return null;
    props.rendered.add(ownId);
    onCleanup(() => props.rendered.delete(ownId));
  }

  const [quoteChildren, setQuoteChildren] = createSignal<QuoteChild[]>([]);
  const [expanded, setExpanded] = createSignal(false);
  const [loadState, setLoadState] = createSignal<
    "idle" | "loading" | "errored"
  >("idle");
  const [quoteCursor, setQuoteCursor] = createSignal<string | null>(null);
  const [quoteHasMore, setQuoteHasMore] = createSignal(false);
  // Dedup across pages.
  const seen = new Set<string>();
  // `fetchQuery` is one-shot (next then complete), and the `loadState` guard
  // below prevents overlapping loads, so the subscription needs no manual
  // unsubscribe (unsubscribing an in-flight request throws `AbortError`).  This
  // flag just stops late callbacks from touching state after unmount.
  let disposed = false;
  // Bounds the deep-link auto-pagination; reset on each fresh load.
  let autoQuotePages = 0;
  // A reload requested while a fetch is in flight runs after it settles, so
  // a quote composed mid-load is not silently dropped.
  let reloadQueued = false;
  onCleanup(() => disposed = true);

  const quoteCount = () => post()?.engagementStats.quotes ?? 0;
  // Whether any quote is visible to the viewer. The raw `quotes` counter above
  // still drives the collapsed label (it is public, shown in the engagement
  // bar), but the quote branch and its auto-expansion gate on this so a post
  // whose quotes are all hidden from the viewer does not surface a "show
  // quotes" affordance that then loads an empty list.
  const hasVisibleQuotes = () => post()?.hasVisibleQuotes ?? false;

  const replyChildren = createMemo<readonly SubtreeReplyNode[]>(() => {
    const p = post();
    if (p == null) return [];
    return props.repliesOf(p.id).filter((child) =>
      child.id !== p.id && !(props.visited?.has(child.id))
    );
  });
  // A reply that also quotes this post renders once, as a reply; the quote
  // occurrence is filtered out.
  const replyIds = createMemo(() =>
    new Set(replyChildren().map((child) => child.id))
  );
  const visibleQuoteChildren = createMemo(() =>
    quoteChildren().filter((child) => !replyIds().has(child.id))
  );
  // The server's `descendants` depth cap can leave a node with visible replies
  // that never loaded, even after the subtree's pagination is exhausted; its
  // own permalink picks the thread up from there. Gate on `hasVisibleReplies`
  // (not the raw counter) so a node whose only replies are hidden from the
  // viewer shows no link, which would otherwise reveal that they exist.
  const continueHere = createMemo(() =>
    replyChildren().length < 1 &&
    (post()?.hasVisibleReplies ?? false) &&
    !props.subtreeMayContinue
  );

  // Drop a deleted quote child from the locally fetched signal; its subtree
  // unmounts and releases its `rendered` claim.
  const removeQuoteChild = (id: string) => {
    seen.delete(id);
    setQuoteChildren((prev) => prev.filter((child) => child.id !== id));
  };

  function loadQuotes(mode: "initial" | "more" = "initial") {
    const p = post();
    if (p == null) return;
    if (loadState() === "loading") {
      if (mode === "initial") reloadQueued = true;
      return;
    }
    if (mode === "initial") {
      seen.clear();
      autoQuotePages = 0;
      setQuoteChildren([]);
      setQuoteCursor(null);
      setQuoteHasMore(false);
    }
    setExpanded(true);
    setLoadState("loading");
    fetchQuery<NewsDiscussionThreadChildrenQuery>(
      environment(),
      quotesQuery,
      {
        id: p.id,
        quoteCursor: mode === "more" ? quoteCursor() : null,
        actingAccountId: actingAccountId() ?? null,
      },
    ).subscribe({
      next(data) {
        if (disposed) return;
        runWithOwner(owner, () => {
          const node = data.node;
          const quotes: QuoteChild[] = [];
          for (const edge of node?.quotes?.edges ?? []) {
            const n = edge?.node;
            if (n == null) continue;
            if (n.id === p.id) continue; // never re-render self
            if (props.visited?.has(n.id)) continue; // ancestor already shows it
            if (seen.has(n.id)) continue; // already loaded under this node
            seen.add(n.id);
            quotes.push({ id: n.id, key: n });
          }
          setQuoteChildren((prev) =>
            mode === "more" ? [...prev, ...quotes] : quotes
          );
          setQuoteCursor(node?.quotes?.pageInfo?.endCursor ?? null);
          setQuoteHasMore(node?.quotes?.pageInfo?.hasNextPage ?? false);
          setLoadState("idle");
          if (reloadQueued) {
            reloadQueued = false;
            loadQuotes();
            return;
          }
          maybeAutoPaginate();
        });
      },
      error() {
        if (disposed) return;
        runWithOwner(owner, () => {
          setLoadState("errored");
          reloadQueued = false;
        });
      },
    });
  }

  // While following a deep link, keep paginating the quotes toward the
  // buried target, capped by page count and by depth so the expansion stays
  // bounded.  (Reply pages are chased by the enclosing subtree instead.)
  function maybeAutoPaginate() {
    if (
      props.targetUuid == null ||
      props.depth >= NEWS_DISCUSSION_TARGET_MAX_DEPTH
    ) {
      return;
    }
    if (quoteHasMore() && autoQuotePages < NEWS_DISCUSSION_TARGET_MAX_PAGES) {
      autoQuotePages++;
      loadQuotes("more");
    }
  }

  onMount(() => {
    // Composing a quote of this post refreshes its loaded quotes.  (Replies
    // are refreshed by the enclosing subtree's bulk reload.)
    onCleanup(onNoteCreated(() => {
      if (quotedPostId() === post()?.id) loadQuotes();
    }));
    if (
      hasVisibleQuotes() &&
      (props.depth < NEWS_DISCUSSION_AUTO_DEPTH ||
        (props.targetUuid != null &&
          props.depth < NEWS_DISCUSSION_TARGET_MAX_DEPTH))
    ) {
      loadQuotes();
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
              <PostAuthorAvatar $post={p} />
              <div class="min-w-0 grow">
                <div class="flex min-w-0 flex-wrap items-baseline gap-x-1">
                  <PostAuthorLine
                    $post={p}
                    class="grow"
                    handleClass="text-sm"
                  />
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
                  onEdit={(p.rawContent ?? p.personalRawContent) != null &&
                      p.visibility !== "NONE"
                    ? () =>
                      openForEdit(p.id, {
                        content: (p.rawContent ?? p.personalRawContent)!,
                        language: p.language,
                        quotePolicy: (p.quotePolicy as QuotePolicy) ??
                          "EVERYONE",
                        visibility: (p.visibility as PostVisibility) ??
                          "PUBLIC",
                        authorAccountId: p.rawContent != null &&
                            p.actor.account?.kind === "ORGANIZATION"
                          ? p.actor.account.id
                          : null,
                      })
                    : undefined}
                  class="mt-1"
                />
              </div>
            </div>
          </article>

          <Show when={hasVisibleQuotes() || replyChildren().length > 0}>
            <div class="ml-4 sm:ml-6">
              <Show when={hasVisibleQuotes()}>
                <Show
                  when={expanded()}
                  fallback={
                    <button
                      type="button"
                      onClick={() => loadQuotes()}
                      class="block w-full cursor-pointer px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-primary"
                    >
                      {t`Show ${quoteCount()} more in this thread`}
                    </button>
                  }
                >
                  <Key each={visibleQuoteChildren()} by={(child) => child.id}>
                    {(child) => (
                      <NewsDiscussionSubtree
                        $post={child().key}
                        depth={props.depth + 1}
                        targetUuid={props.targetUuid}
                        visited={childVisited()}
                        rendered={props.rendered}
                        connections={props.connections}
                        onDeleted={() => removeQuoteChild(child().id)}
                      />
                    )}
                  </Key>
                  <Show when={quoteHasMore()}>
                    <button
                      type="button"
                      onClick={() => loadQuotes("more")}
                      disabled={loadState() === "loading"}
                      class="block w-full cursor-pointer px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-primary disabled:opacity-60"
                    >
                      {t`Load more quotes`}
                    </button>
                  </Show>
                  <Show when={loadState() === "errored"}>
                    <button
                      type="button"
                      onClick={() => loadQuotes()}
                      class="block w-full cursor-pointer px-4 py-2 text-left text-sm text-error transition-colors hover:underline"
                    >
                      {t`Failed to load quotes; click to retry`}
                    </button>
                  </Show>
                </Show>
              </Show>
              <Key each={replyChildren()} by={(child) => child.id}>
                {(child) => (
                  <NewsDiscussionThread
                    $post={child().key}
                    depth={props.depth + 1}
                    targetUuid={props.targetUuid}
                    visited={childVisited()}
                    rendered={props.rendered}
                    connections={props.connections}
                    onDeleted={() => props.onReplyDeleted?.(child().id)}
                    repliesOf={props.repliesOf}
                    onReplyDeleted={props.onReplyDeleted}
                    subtreeMayContinue={props.subtreeMayContinue}
                  />
                )}
              </Key>
            </div>
          </Show>
          <Show when={continueHere()}>
            <div class="ml-4 sm:ml-6">
              <a
                href={p.url ?? p.iri}
                class="block px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-primary"
              >
                {t`Continue this thread`} →
              </a>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
