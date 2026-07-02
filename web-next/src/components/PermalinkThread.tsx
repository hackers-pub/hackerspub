import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { Key } from "@solid-primitives/keyed";
import { useLocation } from "@solidjs/router";
import { graphql } from "relay-runtime";
import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  Match,
  onMount,
  Show,
  splitProps,
  Switch,
} from "solid-js";
import {
  createFragment,
  createPaginationFragment,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { InternalLink } from "~/components/InternalLink.tsx";
import { MutedReplyPlaceholder } from "~/components/MutedReplyPlaceholder.tsx";
import { PostAuthorAvatar, PostAuthorLine } from "~/components/PostAuthor.tsx";
import { PostEngagementBar } from "~/components/PostEngagementBar.tsx";
import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useContentLinkInterceptor } from "~/lib/contentLinkInterceptor.ts";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import { useMentionHoverCards } from "~/lib/mentionHoverCards.tsx";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { PermalinkThread_contextPost$key } from "./__generated__/PermalinkThread_contextPost.graphql.ts";
import type {
  PermalinkThread_post$data,
  PermalinkThread_post$key,
} from "./__generated__/PermalinkThread_post.graphql.ts";
import type {
  PermalinkThread_replyNode$data,
  PermalinkThread_replyNode$key,
} from "./__generated__/PermalinkThread_replyNode.graphql.ts";
import type { PermalinkThreadQuery } from "./__generated__/PermalinkThreadQuery.graphql.ts";
import type {
  PermalinkThreadTree_post$data,
  PermalinkThreadTree_post$key,
} from "./__generated__/PermalinkThreadTree_post.graphql.ts";

// When the ancestor chain is longer than this, the middle collapses behind a
// "Show N more posts" row (the root and the nearest ancestors stay visible).
const ANCESTOR_COLLAPSE_THRESHOLD = 6;
// How many nearest ancestors stay visible above the focused post while the
// middle of a long chain is collapsed.
const ANCESTOR_NEAREST_VISIBLE = 3;
// Reply tree page size for each "load more" (the initial page size is the
// fragment's `count` default, 60).
const TREE_PAGE_SIZE = 60;
// Nesting deeper than this stops indenting so the column never runs out of
// width; the data still renders, just flat.
const TREE_VISUAL_DEPTH_CAP = 6;
// Following a `#post-<uuid>` deep link auto-loads more pages to reach the
// target, but only this many, so a hash cannot fan out into fetching the
// entire thread.
const TREE_TARGET_MAX_PAGES = 5;

export const PERMALINK_THREAD_QUERY_KEY = "loadPermalinkThreadQuery";

const PermalinkThreadQuery = graphql`
  query PermalinkThreadQuery(
    $handle: String!
    $noteId: UUID!
    $actingAccountId: ID
  ) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $noteId, actingAccountId: $actingAccountId) {
        ...PermalinkThread_post @arguments(actingAccountId: $actingAccountId)
      }
    }
  }
`;

export const loadPermalinkThreadQuery = routePreloadedQuery(
  (username: string, noteId: Uuid, actingAccountId: string | null) =>
    loadQuery<PermalinkThreadQuery>(
      useRelayEnvironment()(),
      PermalinkThreadQuery,
      { handle: username, noteId, actingAccountId },
      { fetchPolicy: "store-and-network" },
    ),
  PERMALINK_THREAD_QUERY_KEY,
);

export interface PermalinkThreadProps {
  children: JSX.Element;
  noteId: Uuid;
  username: string;
}

export function PermalinkThread(props: PermalinkThreadProps) {
  return (
    // Guard against transiently-invalid params during route transitions:
    // useParams() can briefly reflect a different route before this component
    // unmounts, causing createStablePreloadedQuery to fire with undefined
    // noteId.
    <Show when={validateUuid(props.noteId)} fallback={<>{props.children}</>}>
      <ErrorBoundary fallback={() => <>{props.children}</>}>
        <PermalinkThreadLoaded {...props} />
      </ErrorBoundary>
    </Show>
  );
}

function PermalinkThreadLoaded(props: PermalinkThreadProps) {
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const location = useLocation();
  const data = createStablePreloadedQuery<PermalinkThreadQuery>(
    PermalinkThreadQuery,
    () =>
      loadPermalinkThreadQuery(
        props.username,
        props.noteId,
        actingAccountId() ?? null,
      ),
  );
  const post = createFragment(
    graphql`
      fragment PermalinkThread_post on Post
        @argumentDefinitions(
          actingAccountId: { type: "ID", defaultValue: null }
        )
      {
        id
        uuid
        ... on Note {
          sourceId
        }
        ... on Question {
          sourceId
        }
        ... on Article {
          sourceId
        }
        replyTarget(actingAccountId: $actingAccountId) {
          id
        }
        # Fetched in one shot rather than paginated: real chains top out
        # around a hundred hops, and ancestor rows are light context cards.
        ancestors(first: 120, actingAccountId: $actingAccountId) {
          edges {
            node {
              id
              replyTarget(actingAccountId: $actingAccountId) {
                id
              }
              ...PermalinkThread_contextPost
            }
          }
          pageInfo {
            hasNextPage
          }
        }
        ...PermalinkThreadTree_post @arguments(
          actingAccountId: $actingAccountId
        )
      }
    `,
    () => data()?.actorByHandle?.postByUuid as PermalinkThread_post$key,
  );
  // Relay can briefly republish this fragment as `null` when another update
  // touches the same `Post` record. Keep the permalink thread mounted across
  // that gap so opening action popovers does not drop the thread.
  const stablePost = createMemo<
    {
      routeKey: string;
      value: PermalinkThread_post$data;
    } | null
  >((previous) => {
    const routeKey = `${props.username}/${props.noteId}`;
    const value = post();
    if (
      value != null &&
      (value.uuid === props.noteId || value.sourceId === props.noteId)
    ) {
      return { routeKey, value };
    }
    return previous?.routeKey === routeKey ? previous : null;
  });

  const targetUuid = createMemo(() => {
    const match = /^#post-([0-9a-f-]{36})$/.exec(location.hash);
    return match == null ? null : match[1];
  });
  // A hash for the focused post itself is handled here (it can never be
  // found among the descendants), so the tree only chases hashes for other
  // posts.
  const targetIsFocused = createMemo(() => {
    const target = targetUuid();
    const value = stablePost()?.value;
    return target != null && value != null &&
      (target === value.uuid || target === value.sourceId);
  });
  const treeTargetUuid = createMemo(() =>
    targetIsFocused() ? null : targetUuid()
  );

  // With ancestors above the focused post, land the reader on the focused
  // post itself (Mastodon-style); the ancestors stay reachable by scrolling
  // up. A `#post-<uuid>` deep link to another post takes precedence and is
  // handled by the tree.
  let focusedRef: HTMLDivElement | undefined;
  let scrolledTo: string | null = null;
  createEffect(() => {
    const current = stablePost();
    if (current == null || scrolledTo === current.routeKey) return;
    if (targetUuid() != null && !targetIsFocused()) return;
    if (
      !targetIsFocused() &&
      (current.value.ancestors?.edges.length ?? 0) < 1
    ) return;
    scrolledTo = current.routeKey;
    requestAnimationFrame(() => {
      focusedRef?.scrollIntoView({ block: "start" });
    });
  });

  return (
    <Show keyed when={stablePost()} fallback={props.children}>
      {(current) => (
        <div class="contents">
          <PermalinkAncestors
            post={current.value}
            focusedReplyTargetId={current.value.replyTarget?.id ?? null}
          />
          <div
            ref={focusedRef}
            id={`post-${current.value.uuid}`}
            class="scroll-mt-20"
          >
            {props.children}
          </div>
          <PermalinkThreadTree
            $post={current.value}
            focusedPostId={current.value.id}
            targetUuid={treeTargetUuid()}
          />
        </div>
      )}
    </Show>
  );
}

type AncestorEdgeNode = NonNullable<
  PermalinkThread_post$data["ancestors"]
>["edges"][number]["node"];

interface PermalinkAncestorsProps {
  post: PermalinkThread_post$data;
  focusedReplyTargetId: string | null;
}

type AncestorRow =
  | { kind: "post"; node: AncestorEdgeNode }
  | { kind: "fold" };

function PermalinkAncestors(props: PermalinkAncestorsProps) {
  const { t, i18n } = useLingui();
  const [expanded, setExpanded] = createSignal(false);

  // Server order is nearest-first; display order is root-first. Relay can
  // surface a null edge or node for a record it could not fetch, so guard
  // before dereferencing (same as `PermalinkThreadTree`'s node list).
  const chain = createMemo<AncestorEdgeNode[]>(() =>
    (props.post.ancestors?.edges ?? [])
      .flatMap((edge) => edge?.node == null ? [] : [edge.node])
      // `flatMap` already returns a fresh array, so reverse it in place rather
      // than with the ES2023-only `toReversed()`.
      .reverse()
  );
  const hasMoreAbove = createMemo(() => {
    const rows = chain();
    if (rows.length < 1) return false;
    return rows[0].replyTarget != null ||
      (props.post.ancestors?.pageInfo.hasNextPage ?? false);
  });
  const collapsed = createMemo(() =>
    !expanded() && chain().length > ANCESTOR_COLLAPSE_THRESHOLD
  );
  const hiddenCount = createMemo(() =>
    chain().length - 1 - ANCESTOR_NEAREST_VISIBLE
  );
  const visibleRows = createMemo<AncestorRow[]>(() => {
    const rows = chain();
    if (!collapsed()) {
      return rows.map((node) => ({ kind: "post" as const, node }));
    }
    return [
      { kind: "post" as const, node: rows[0] },
      { kind: "fold" as const },
      ...rows.slice(rows.length - ANCESTOR_NEAREST_VISIBLE)
        .map((node) => ({ kind: "post" as const, node })),
    ];
  });
  // A gap between two adjacent rows means one or more posts in between are
  // not visible to the viewer (the row below does not reply to the row
  // above). No marker around the collapsed fold; it already stands for
  // not-shown posts.
  const gapAfter = (index: number): boolean => {
    const rows = visibleRows();
    const above = rows[index];
    const below = rows[index + 1];
    if (above == null || above.kind !== "post") return false;
    if (below == null) {
      return props.focusedReplyTargetId !== above.node.id;
    }
    if (below.kind !== "post") return false;
    return below.node.replyTarget?.id !== above.node.id;
  };

  return (
    <Show when={chain().length > 0}>
      <div class="border-x border-t rounded-t-xl overflow-hidden">
        <Show when={hasMoreAbove()}>
          <EarlierPostsLink $post={chain()[0]} />
        </Show>
        <For each={visibleRows()}>
          {(row, index) => (
            <>
              <Switch>
                <Match when={row.kind === "fold"}>
                  <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    class="block w-full cursor-pointer border-b px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/30 hover:text-primary"
                  >
                    {i18n._(
                      msg`${
                        plural(hiddenCount(), {
                          one: "Show # more post",
                          other: "Show # more posts",
                        })
                      }`,
                    )}
                  </button>
                </Match>
                <Match keyed when={row.kind === "post" ? row.node : null}>
                  {(node) => <ContextPostCard $post={node} />}
                </Match>
              </Switch>
              <Show when={gapAfter(index())}>
                <div class="border-b px-4 py-2.5 text-sm text-muted-foreground">
                  {t`Some posts in this thread cannot be shown.`}
                </div>
              </Show>
            </>
          )}
        </For>
      </div>
    </Show>
  );
}

interface EarlierPostsLinkProps {
  $post: PermalinkThread_contextPost$key;
}

function EarlierPostsLink(props: EarlierPostsLinkProps) {
  const { t } = useLingui();
  const post = createFragment(
    contextPostFragment,
    () => props.$post,
  );
  return (
    <Show keyed when={post()}>
      {(post) => (
        <ContextPostLink
          href={post.url ?? post.iri}
          internalHref={getPostInternalHref(post)}
          class="block border-b px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/30 hover:text-primary"
        >
          {t`View earlier posts in this thread`}
        </ContextPostLink>
      )}
    </Show>
  );
}

const PermalinkThreadTreeFragment = graphql`
  fragment PermalinkThreadTree_post on Post
    @refetchable(queryName: "PermalinkThreadTreePaginationQuery")
    @argumentDefinitions(
      cursor: { type: "String" }
      count: { type: "Int", defaultValue: 60 }
      actingAccountId: { type: "ID", defaultValue: null }
    )
  {
    id
    descendants(
      after: $cursor
      first: $count
      actingAccountId: $actingAccountId
    )
      @connection(key: "PermalinkThreadTree_descendants")
    {
      __id
      edges {
        node {
          id
          uuid
          ... on Note {
            sourceId
          }
          ... on Question {
            sourceId
          }
          ... on Article {
            sourceId
          }
          replyTarget(actingAccountId: $actingAccountId) {
            id
          }
          hasVisibleReplies(actingAccountId: $actingAccountId)
          actor {
            id
          }
          ...PermalinkThread_replyNode @arguments(
            actingAccountId: $actingAccountId
          )
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

type TreeEdgeNode = NonNullable<
  PermalinkThreadTree_post$data["descendants"]
>["edges"][number]["node"];

export interface PermalinkThreadTreeProps {
  $post: PermalinkThreadTree_post$key;
  focusedPostId: string;
  targetUuid: string | null;
  /**
   * Container chrome. The default attaches the tree flush under the focused
   * post's card; standalone surfaces (e.g. the article page's comments
   * section) pass a fully rounded box instead.
   */
  class?: string;
}

export function PermalinkThreadTree(props: PermalinkThreadTreeProps) {
  const { t } = useLingui();
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");
  const tree = createPaginationFragment(
    PermalinkThreadTreeFragment,
    () => props.$post,
  );

  const nodes = createMemo<TreeEdgeNode[]>(() =>
    (tree()?.descendants?.edges ?? []).flatMap((edge) =>
      edge?.node == null ? [] : [edge.node]
    )
  );
  const connectionId = () => tree()?.descendants?.__id;
  // The server guarantees a parent appears before its replies, so this map
  // rebuilds the tree from `replyTarget` ids alone. Nodes whose parent was
  // filtered out server-side never make it into any reachable bucket.
  const childrenByParent = createMemo(() => {
    const map = new Map<string, TreeEdgeNode[]>();
    for (const node of nodes()) {
      const parentId = node.replyTarget?.id;
      if (parentId == null) continue;
      let bucket = map.get(parentId);
      if (bucket == null) {
        bucket = [];
        map.set(parentId, bucket);
      }
      bucket.push(node);
    }
    return map;
  });
  const roots = createMemo(() =>
    childrenByParent().get(props.focusedPostId) ?? []
  );

  function onLoadMore() {
    setLoadingState("loading");
    tree.loadNext(TREE_PAGE_SIZE, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  // Following a deep link into a page that is not loaded yet: keep loading
  // more pages toward the target, bounded per target.
  let targetPages = 0;
  let lastTarget: string | null = null;
  createEffect(() => {
    const target = props.targetUuid;
    if (target !== lastTarget) {
      lastTarget = target;
      targetPages = 0;
    }
    if (target == null || targetPages >= TREE_TARGET_MAX_PAGES) return;
    if (
      nodes().some((node) => node.uuid === target || node.sourceId === target)
    ) return;
    if (!tree.hasNext || tree.pending || loadingState() === "loading") return;
    targetPages++;
    onLoadMore();
  });

  return (
    <Show when={roots().length > 0 || tree.hasNext}>
      <div
        class={props.class ?? "border-x border-b rounded-b-xl overflow-hidden"}
      >
        <Key each={roots()} by={(node) => node.id}>
          {(node) => (
            <ThreadReplyNode
              node={node()}
              childrenByParent={childrenByParent()}
              visualDepth={0}
              targetUuid={props.targetUuid}
              connectionId={connectionId()}
              subtreeMayContinue={tree.hasNext}
            />
          )}
        </Key>
        <Show when={tree.hasNext}>
          <button
            type="button"
            onClick={onLoadMore}
            disabled={tree.pending || loadingState() === "loading"}
            class="block w-full cursor-pointer border-t px-4 py-4 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Switch>
              <Match when={tree.pending || loadingState() === "loading"}>
                {t`Loading more replies…`}
              </Match>
              <Match when={loadingState() === "errored"}>
                {t`Failed to load more replies; click to retry`}
              </Match>
              <Match when={loadingState() === "loaded"}>
                {t`Load more replies`}
              </Match>
            </Switch>
          </button>
        </Show>
      </div>
    </Show>
  );
}

interface ThreadReplyNodeProps {
  node: TreeEdgeNode;
  childrenByParent: Map<string, TreeEdgeNode[]>;
  visualDepth: number;
  targetUuid: string | null;
  connectionId: string | undefined;
  /** Whether unloaded pages may still add replies below this subtree. */
  subtreeMayContinue: boolean;
}

function ThreadReplyNode(props: ThreadReplyNodeProps) {
  const { t, i18n } = useLingui();
  const [collapsed, setCollapsed] = createSignal(false);

  const children = () => props.childrenByParent.get(props.node.id) ?? [];
  // A run of single same-author replies reads as one continuous column:
  // no indentation, no rail. Long single-author threads are common on the
  // fediverse and would otherwise stairstep off the screen.
  const flushChildren = createMemo(() => {
    const kids = children();
    return kids.length === 1 && kids[0].actor.id === props.node.actor.id;
  });
  const indentChildren = createMemo(() =>
    !flushChildren() && props.visualDepth < TREE_VISUAL_DEPTH_CAP
  );
  const childVisualDepth = createMemo(() =>
    indentChildren() ? props.visualDepth + 1 : props.visualDepth
  );
  const subtreeSize = createMemo(() => {
    let count = 0;
    const queue = [...children()];
    while (queue.length > 0) {
      const node = queue.pop()!;
      count++;
      queue.push(...(props.childrenByParent.get(node.id) ?? []));
    }
    return count;
  });
  // The depth cap can leave a node with visible replies that never loaded,
  // even after the whole connection is exhausted; its own permalink picks the
  // thread up from there. Gate on `hasVisibleReplies` (not the raw counter) so
  // a node whose only replies are hidden from the viewer shows no link, which
  // would otherwise reveal that those hidden replies exist.
  const continueHere = createMemo(() =>
    children().length < 1 &&
    props.node.hasVisibleReplies &&
    !props.subtreeMayContinue
  );

  return (
    <div>
      <ThreadReplyRow
        $post={props.node}
        targetUuid={props.targetUuid}
        connectionId={props.connectionId}
      />
      <Show when={children().length > 0}>
        <Show
          when={!collapsed()}
          fallback={
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              class={`block w-full cursor-pointer px-4 pb-3 text-left text-sm text-muted-foreground transition-colors hover:text-primary${
                indentChildren() ? " pl-8 sm:pl-10" : ""
              }`}
            >
              {i18n._(
                msg`${
                  plural(subtreeSize(), {
                    one: "Show # reply",
                    other: "Show # replies",
                  })
                }`,
              )}
            </button>
          }
        >
          <div class="flex">
            <Show when={indentChildren()}>
              {
                /* The rail is the collapse control: the whole strip is
                  clickable, and the hairline darkens on hover to show it. */
              }
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                aria-label={t`Hide replies`}
                class="group w-4 sm:w-6 shrink-0 cursor-pointer"
              >
                <span class="block h-full w-px ml-4 sm:ml-5 bg-border transition-colors group-hover:bg-muted-foreground" />
              </button>
            </Show>
            <div class="min-w-0 grow">
              <Key each={children()} by={(node) => node.id}>
                {(child) => (
                  <ThreadReplyNode
                    node={child()}
                    childrenByParent={props.childrenByParent}
                    visualDepth={childVisualDepth()}
                    targetUuid={props.targetUuid}
                    connectionId={props.connectionId}
                    subtreeMayContinue={props.subtreeMayContinue}
                  />
                )}
              </Key>
            </div>
          </div>
        </Show>
      </Show>
      <Show when={continueHere()}>
        <ContinueThreadLink $post={props.node} indent={indentChildren()} />
      </Show>
    </div>
  );
}

const replyNodeFragment = graphql`
  fragment PermalinkThread_replyNode on Post
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
      sourceId
      personalRawContent: rawContent
      rawContent(actingAccountId: $actingAccountId)
      quotePolicy
    }
    ... on Question {
      sourceId
    }
    ... on Article {
      sourceId
      name
      publishedYear
      slug
      excerptHtml(maxChars: 700)
    }
    actor {
      name
      handle
      username
      local
      url
      iri
      viewerMutes
      account {
        id
        kind
      }
    }
    ...PostAuthorAvatar_post
    ...PostAuthorLine_post
    ...PostEngagementBar_post @arguments(actingAccountId: $actingAccountId)
  }
`;

interface ThreadReplyRowProps {
  $post: PermalinkThread_replyNode$key;
  targetUuid: string | null;
  connectionId: string | undefined;
}

function ThreadReplyRow(props: ThreadReplyRowProps) {
  const { openForEdit } = useNoteCompose();
  const post = createFragment(replyNodeFragment, () => props.$post);
  const [revealed, setRevealed] = createSignal(false);
  const [proseRef, setProseRef] = createSignal<HTMLElement>();
  useMentionHoverCards(proseRef);
  useContentLinkInterceptor(proseRef);

  const isTarget = (p: PermalinkThread_replyNode$data) =>
    props.targetUuid != null &&
    (p.uuid === props.targetUuid || p.sourceId === props.targetUuid);

  let articleRef: HTMLElement | undefined;
  onMount(() => {
    const p = post();
    if (p != null && isTarget(p) && articleRef != null) {
      requestAnimationFrame(() =>
        articleRef?.scrollIntoView({ block: "center" })
      );
    }
  });

  const engagementBase = (p: PermalinkThread_replyNode$data) => {
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
        <Show
          when={!p.actor.viewerMutes || revealed()}
          fallback={
            <MutedReplyPlaceholder
              handle={p.actor.handle}
              onReveal={() => setRevealed(true)}
            />
          }
        >
          <article
            ref={articleRef}
            id={`post-${p.uuid}`}
            class="scroll-mt-20 px-4 py-3 transition-colors"
            classList={{
              "bg-info/10": isTarget(p),
              "hover:bg-muted/30": !isTarget(p),
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
                  <ContextPostLink
                    href={p.url ?? p.iri}
                    internalHref={getPostInternalHref(p)}
                    class="text-sm text-muted-foreground/70 hover:underline"
                  >
                    <Timestamp value={p.published} />
                  </ContextPostLink>
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
                            <ContextPostLink
                              href={p.url ?? p.iri}
                              internalHref={getPostInternalHref(p)}
                              class="hover:underline"
                            >
                              {name}
                            </ContextPostLink>
                          </h3>
                        )}
                      </Show>
                      <div
                        ref={setProseRef}
                        innerHTML={p.excerptHtml}
                        lang={p.language ?? undefined}
                        class="prose dark:prose-invert mt-1 line-clamp-4 max-w-none break-words text-sm text-muted-foreground"
                      />
                    </div>
                  </Match>
                </Switch>
                <PostEngagementBar
                  $post={p}
                  repliesHref={null}
                  engagementBase={engagementBase(p)}
                  connections={props.connectionId == null
                    ? []
                    : [props.connectionId]}
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
        </Show>
      )}
    </Show>
  );
}

interface ContinueThreadLinkProps {
  $post: PermalinkThread_replyNode$key;
  indent: boolean;
}

function ContinueThreadLink(props: ContinueThreadLinkProps) {
  const { t } = useLingui();
  const post = createFragment(replyNodeFragment, () => props.$post);
  return (
    <Show keyed when={post()}>
      {(p) => (
        <ContextPostLink
          href={p.url ?? p.iri}
          internalHref={getPostInternalHref(p)}
          class={`block px-4 pb-3 text-sm text-muted-foreground transition-colors hover:text-primary${
            props.indent ? " pl-8 sm:pl-10" : ""
          }`}
        >
          {t`Continue this thread`} →
        </ContextPostLink>
      )}
    </Show>
  );
}

const contextPostFragment = graphql`
  fragment PermalinkThread_contextPost on Post {
    __typename
    uuid
    name
    excerpt
    published
    url
    iri
    ... on Article {
      publishedYear
      slug
    }
    ... on Note {
      sourceId
    }
    ... on Question {
      sourceId
    }
    actor {
      name
      handle
      username
      local
      url
      iri
      viewerMutes
    }
    ...PostAuthorAvatar_post
    ...PostAuthorLine_post
  }
`;

interface ContextPostCardProps {
  $post: PermalinkThread_contextPost$key;
}

function ContextPostCard(props: ContextPostCardProps) {
  const post = createFragment(contextPostFragment, () => props.$post);
  const [revealed, setRevealed] = createSignal(false);

  return (
    <Show keyed when={post()}>
      {(post) => {
        const href = () => post.url ?? post.iri;
        const internalHref = () => getPostInternalHref(post);
        return (
          <Show
            when={!post.actor?.viewerMutes || revealed()}
            fallback={
              <div class="border-b last:border-none">
                <MutedReplyPlaceholder
                  handle={post.actor.handle}
                  onReveal={() => setRevealed(true)}
                />
              </div>
            }
          >
            <article class="border-b px-4 py-3 transition-colors hover:bg-muted/30 last:border-none">
              <div class="flex gap-3 sm:gap-4">
                <PostAuthorAvatar $post={post} />
                <div class="min-w-0 grow">
                  <div class="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
                    <PostAuthorLine $post={post} class="grow" />
                    <span class="flex items-center gap-1.5 text-sm text-muted-foreground/70">
                      <ContextPostLink
                        href={href()}
                        internalHref={internalHref()}
                      >
                        <Timestamp
                          value={post.published}
                          capitalizeFirstLetter
                        />
                      </ContextPostLink>
                    </span>
                  </div>
                  <ContextPostLink
                    href={href()}
                    internalHref={internalHref()}
                    class="mt-1 block text-sm text-foreground"
                  >
                    <Show
                      when={post.name != null && post.name.trim() !== ""}
                      fallback={post.excerpt}
                    >
                      <span class="font-medium">{post.name}</span>
                    </Show>
                  </ContextPostLink>
                </div>
              </div>
            </article>
          </Show>
        );
      }}
    </Show>
  );
}

interface PostPermalinkParts {
  readonly __typename: string;
  readonly uuid: string;
  readonly sourceId?: string | null;
  readonly publishedYear?: number | null;
  readonly slug?: string | null;
  readonly actor: {
    readonly handle: string;
    readonly username: string;
    readonly local: boolean;
  };
}

function getPostInternalHref(post: PostPermalinkParts): string | null {
  const actorSegment = post.actor.local
    ? `@${post.actor.username}`
    : encodeHandleSegment(post.actor.handle);
  switch (post.__typename) {
    case "Article":
      if (
        post.actor.local &&
        post.publishedYear != null &&
        post.slug != null
      ) {
        return `/@${post.actor.username}/${post.publishedYear}/${post.slug}`;
      }
      // Articles without a pretty permalink (remote, or local rows
      // that haven't materialised `publishedYear`/`slug`) route through
      // the UUID-based `[noteId]` permalink, which now accepts
      // articles.
      return `/${actorSegment}/${post.uuid}`;
    case "Note": {
      // Source-backed local notes: canonical permalink uses `sourceId`
      // (= `noteSourceTable.id`), matching the path embedded in
      // `Post.url`. For everything else — remote notes and local share
      // wrappers (boosts), neither of which carries a source row — fall
      // back to `uuid` (= `postTable.id`), the internal route token.
      const id = post.sourceId ?? post.uuid;
      return `/${actorSegment}/${id}`;
    }
    case "Question": {
      const id = post.sourceId ?? post.uuid;
      return `/${actorSegment}/${id}`;
    }
    default:
      return null;
  }
}

interface ContextPostLinkProps
  extends Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "target"> {
  internalHref: string | null;
}

function ContextPostLink(props: ContextPostLinkProps) {
  const [local, anchorProps] = splitProps(props, [
    "children",
    "internalHref",
  ]);
  return (
    <Show
      keyed
      when={local.internalHref}
      fallback={<a {...anchorProps}>{local.children}</a>}
    >
      {(internalHref) => (
        <InternalLink {...anchorProps} internalHref={internalHref}>
          {local.children}
        </InternalLink>
      )}
    </Show>
  );
}
