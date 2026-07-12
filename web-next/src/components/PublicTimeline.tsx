import { fetchQuery, graphql } from "relay-runtime";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { createPaginationFragment, useRelayEnvironment } from "solid-relay";
import { LazyMount } from "~/components/LazyMount.tsx";
import { PostCard } from "~/components/PostCard.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { createChunkedVisibleCount } from "~/lib/deferredRender.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type {
  PublicTimeline_posts$data,
  PublicTimeline_posts$key,
} from "./__generated__/PublicTimeline_posts.graphql.ts";
import type { PublicTimelinePollQuery } from "./__generated__/PublicTimelinePollQuery.graphql.ts";

// Fetches only the newest edge's cursor to detect new content without
// updating the main connection in the Relay store.
const pollQuery = graphql`
  query PublicTimelinePollQuery(
    $languages: [Locale!]
    $local: Boolean
    $postType: PostType
    $withoutShares: Boolean
  ) {
    publicTimeline(
      first: 1,
      languages: $languages,
      local: $local,
      postType: $postType,
      withoutShares: $withoutShares,
    ) {
      edges {
        cursor
      }
    }
  }
`;

export interface PublicTimelineProps {
  $posts: PublicTimeline_posts$key;
  activeLanguage?: () => string | undefined;
  local?: boolean;
  postType?: "ARTICLE" | "NOTE" | "QUESTION" | null;
  withoutShares?: boolean;
}

export function PublicTimeline(props: PublicTimelineProps) {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const { onNoteCreated } = useNoteCompose();
  const environment = useRelayEnvironment();
  const posts = createPaginationFragment(
    graphql`
      fragment PublicTimeline_posts on Query
        @refetchable(queryName: "PublicTimelineQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 25 }
          actingAccountId: { type: "ID" }
          locale: { type: "Locale" }
          languages: { type: "[Locale!]", }
          local: { type: "Boolean", defaultValue: false }
          postType: { type: "PostType", defaultValue: null}
          withoutShares: { type: "Boolean", defaultValue: false }
        )
      {
        __id
        publicTimeline(
          after: $cursor,
          first: $count,
          languages: $languages,
          local: $local,
          postType: $postType,
          withoutShares: $withoutShares,
        )
          @connection(key: "PublicTimeline__publicTimeline")
        {
          __id
          edges {
            __id
            cursor
            node {
              ...PostCard_post @arguments(
                locale: $locale
                actingAccountId: $actingAccountId
              )
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$posts,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");
  // undefined = not yet initialized; null = initialized but empty timeline.
  const [baselineCursor, setBaselineCursor] = createSignal<
    string | null | undefined
  >(undefined);
  const [hasNewPosts, setHasNewPosts] = createSignal(false);
  // Keep the rendered list mounted while pagination/refetch publishes a
  // transient empty fragment snapshot. If the list unmounts near the bottom of
  // the page, the browser can clamp scrollTop to the top before the next
  // snapshot restores the rows.
  const stableData = createMemo<PublicTimeline_posts$data | undefined>(
    (prev) => posts.latest ?? prev,
    undefined,
  );
  const timeline = createMemo(() => stableData()?.publicTimeline);
  const timelineEdges = createMemo(() => timeline()?.edges ?? []);
  const visiblePostCount = createChunkedVisibleCount(
    () => timelineEdges().length,
    { initialCount: 3, chunkSize: 5 },
  );
  const visibleTimelineEdges = createMemo(() =>
    timelineEdges().slice(0, visiblePostCount())
  );

  // Keep the baseline cursor in sync with whatever is currently displayed.
  // Distinguishes "data not loaded yet" (undefined) from "loaded but empty"
  // (null) so an empty-then-populated timeline still shows the banner.
  // Clears the "new posts" banner whenever the timeline refreshes.
  createEffect(on(
    () => {
      const data = stableData();
      if (data == null) return undefined;
      return data.publicTimeline.edges[0]?.cursor ?? null;
    },
    (cursor) => {
      if (cursor === undefined) return;
      setBaselineCursor(cursor);
      setHasNewPosts(false);
    },
  ));

  // When the language filter changes after initial mount, refetch at the
  // fragment level so the DOM subtree stays mounted (no flash). The top-level
  // query still carries the initial language for SSR; this effect handles
  // subsequent client-side filter changes without reloading the whole query.
  const actingAccountId = () => actingAccount.selectedActingAccountId();

  createEffect(on(
    () => `${props.activeLanguage?.() ?? ""}:${actingAccountId() ?? ""}`,
    () => {
      const lang = props.activeLanguage?.();
      posts.refetch({
        actingAccountId: actingAccountId() ?? null,
        languages: lang ? [lang] : [],
      });
    },
    { defer: true },
  ));

  onMount(() => {
    onCleanup(onNoteCreated(() => {
      const lang = props.activeLanguage?.();
      posts.refetch({
        actingAccountId: actingAccountId() ?? null,
        languages: lang ? [lang] : [],
      });
    }));

    // Poll for new content without disrupting the current view.
    const pollIntervalMs = import.meta.env.DEV ? 10_000 : 60_000;
    let pendingPollSub: { unsubscribe(): void } | null = null;
    let polling = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const [documentVisible, setDocumentVisible] = createSignal(
      document.visibilityState === "visible",
    );
    const onVisibilityChange = () => {
      setDocumentVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const stopPolling = () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      pendingPollSub?.unsubscribe();
      pendingPollSub = null;
      polling = false;
    };

    const poll = () => {
      if (!documentVisible() || posts.pending || hasNewPosts() || polling) {
        return;
      }

      const lang = props.activeLanguage?.();
      polling = true;
      pendingPollSub = fetchQuery<PublicTimelinePollQuery>(
        environment(),
        pollQuery,
        {
          languages: lang ? [lang] : [],
          local: props.local ?? false,
          postType: props.postType ?? null,
          withoutShares: props.withoutShares ?? false,
        },
      ).subscribe({
        next(data) {
          const firstCursor = data.publicTimeline?.edges[0]?.cursor ?? null;
          const baseline = baselineCursor();
          if (baseline !== undefined && firstCursor !== baseline) {
            setHasNewPosts(true);
          }
        },
        error() {
          // Ignore poll errors silently; the next tick will retry.
          polling = false;
          pendingPollSub = null;
        },
        complete() {
          polling = false;
          pendingPollSub = null;
        },
      });
    };

    createEffect(() => {
      if (!documentVisible() || hasNewPosts()) {
        stopPolling();
        return;
      }
      if (intervalId == null) {
        intervalId = setInterval(poll, pollIntervalMs);
      }
    });

    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopPolling();
    });
  });

  function onBannerClick() {
    setHasNewPosts(false);
    const lang = props.activeLanguage?.();
    posts.refetch({
      actingAccountId: actingAccountId() ?? null,
      languages: lang ? [lang] : [],
    });
  }

  function onLoadMore() {
    setLoadingState("loading");
    posts.loadNext(25, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="mt-4 mb-10 overflow-hidden border bg-card md:mb-12 md:rounded-lg md:shadow-sm">
      <Show when={hasNewPosts()}>
        <button
          type="button"
          onClick={onBannerClick}
          class="block w-full cursor-pointer border-b bg-primary/5 px-4 py-3 text-center text-sm font-medium text-primary transition-colors hover:bg-primary/10"
        >
          {t`New posts available — click to load`}
        </button>
      </Show>
      <Show when={stableData()}>
        <For each={visibleTimelineEdges()}>
          {(edge, i) => (
            <LazyMount eager={i() < 3}>
              <PostCard
                $post={edge.node}
                connections={timeline() == null ? [] : [timeline()!.__id]}
                deferHeavySections
              />
            </LazyMount>
          )}
        </For>
        <Show
          when={posts.hasNext && visiblePostCount() >= timelineEdges().length}
        >
          <button
            type="button"
            on:click={loadingState() === "loading" ? undefined : onLoadMore}
            disabled={posts.pending || loadingState() === "loading"}
            class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Switch>
              <Match when={posts.pending || loadingState() === "loading"}>
                {t`Loading more posts…`}
              </Match>
              <Match when={loadingState() === "errored"}>
                {t`Failed to load more posts; click to retry`}
              </Match>
              <Match when={loadingState() === "loaded"}>
                {t`Load more posts`}
              </Match>
            </Switch>
          </button>
        </Show>
        <Show when={timelineEdges().length < 1}>
          <div class="px-4 py-8 text-center text-muted-foreground">
            {t`No posts found`}
          </div>
        </Show>
      </Show>
    </div>
  );
}
