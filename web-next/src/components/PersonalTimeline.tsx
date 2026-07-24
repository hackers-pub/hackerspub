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
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { createChunkedVisibleCount } from "~/lib/deferredRender.ts";
import { useLingui } from "~/lib/i18n/macro.ts";
import type {
  PersonalTimeline_posts$data,
  PersonalTimeline_posts$key,
} from "./__generated__/PersonalTimeline_posts.graphql.ts";
import type { PersonalTimelinePollQuery } from "./__generated__/PersonalTimelinePollQuery.graphql.ts";

// Fetches only the newest edge's cursor to detect new content without
// updating the main connection in the Relay store.
const pollQuery = graphql`
  query PersonalTimelinePollQuery(
    $actingAccountId: ID
    $languages: [Locale!]
    $local: Boolean
    $postType: PostType
    $withoutShares: Boolean
  ) {
    personalTimeline(
      first: 1
      actingAccountId: $actingAccountId
      languages: $languages
      local: $local
      postType: $postType
      withoutShares: $withoutShares
    ) {
      edges {
        cursor
      }
    }
  }
`;

export interface PersonalTimelineProps {
  $posts: PersonalTimeline_posts$key;
  actingAccountId?: () => string | undefined;
  activeLanguage?: () => string | undefined;
  local?: boolean;
  withoutShares?: boolean;
  postType?: "ARTICLE" | "NOTE" | "QUESTION" | null;
}

export function PersonalTimeline(props: PersonalTimelineProps) {
  const { t } = useLingui();
  const { onNoteCreated } = useNoteCompose();
  const environment = useRelayEnvironment();
  const posts = createPaginationFragment(
    graphql`
      fragment PersonalTimeline_posts on Query
      @refetchable(queryName: "PersonalTimelineQuery")
      @argumentDefinitions(
        cursor: { type: "String" }
        count: { type: "Int", defaultValue: 25 }
        actingAccountId: { type: "ID" }
        locale: { type: "Locale" }
        languages: { type: "[Locale!]", defaultValue: [] }
        local: { type: "Boolean", defaultValue: false }
        postType: { type: "PostType", defaultValue: null }
        withoutShares: { type: "Boolean", defaultValue: false }
      ) {
        __id
        personalTimeline(
          after: $cursor
          first: $count
          actingAccountId: $actingAccountId
          languages: $languages
          local: $local
          postType: $postType
          withoutShares: $withoutShares
        ) @connection(key: "PersonalTimeline__personalTimeline") {
          __id
          edges {
            __id
            cursor
            lastSharer {
              name
              local
              username
              handle
            }
            added
            node {
              ...PostCard_post
                @arguments(locale: $locale, actingAccountId: $actingAccountId)
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
  const stableData = createMemo<PersonalTimeline_posts$data | undefined>(
    (prev) => posts.latest ?? prev,
    undefined,
  );
  const timeline = createMemo(() => stableData()?.personalTimeline);
  const timelineEdges = createMemo(() => timeline()?.edges ?? []);
  const visiblePostCount = createChunkedVisibleCount(
    () => timelineEdges().length,
    { initialCount: 3, chunkSize: 5 },
  );
  const visibleTimelineEdges = createMemo(() =>
    timelineEdges().slice(0, visiblePostCount()),
  );

  // Keep the baseline cursor in sync with whatever is currently displayed.
  // Distinguishes "data not loaded yet" (undefined) from "loaded but empty"
  // (null) so an empty-then-populated timeline still shows the banner.
  // Clears the "new posts" banner whenever the timeline refreshes.
  createEffect(
    on(
      () => {
        const data = stableData();
        if (data == null) return undefined;
        return data.personalTimeline.edges[0]?.cursor ?? null;
      },
      (cursor) => {
        if (cursor === undefined) return;
        setBaselineCursor(cursor);
        setHasNewPosts(false);
      },
    ),
  );

  // When the language filter changes after initial mount, refetch at the
  // fragment level so the DOM subtree stays mounted (no flash).
  createEffect(
    on(
      [() => props.activeLanguage?.(), () => props.actingAccountId?.()],
      ([lang, actingAccountId]) => {
        posts.refetch({
          actingAccountId: actingAccountId ?? null,
          languages: lang ? [lang] : [],
        });
      },
      { defer: true },
    ),
  );

  onMount(() => {
    // Stale-while-revalidate: show cached content immediately, refresh in
    // the background so returning to this timeline shows fresh content.
    const lang = props.activeLanguage?.();
    posts.refetch({
      actingAccountId: props.actingAccountId?.() ?? null,
      languages: lang ? [lang] : [],
    });

    onCleanup(
      onNoteCreated(() => {
        const lang = props.activeLanguage?.();
        posts.refetch({
          actingAccountId: props.actingAccountId?.() ?? null,
          languages: lang ? [lang] : [],
        });
      }),
    );

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
      pendingPollSub = fetchQuery<PersonalTimelinePollQuery>(
        environment(),
        pollQuery,
        {
          actingAccountId: props.actingAccountId?.() ?? null,
          languages: lang ? [lang] : [],
          local: props.local ?? false,
          postType: props.postType ?? null,
          withoutShares: props.withoutShares ?? false,
        },
      ).subscribe({
        next(data) {
          const firstCursor = data.personalTimeline?.edges[0]?.cursor ?? null;
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
      actingAccountId: props.actingAccountId?.() ?? null,
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
                sharerActor={edge.lastSharer}
                sharerTimestamp={edge.added}
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
