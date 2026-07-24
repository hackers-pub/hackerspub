import {
  createOperationDescriptor,
  type Disposable,
  fetchQuery,
  getRequest,
  graphql,
} from "relay-runtime";
import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { useRelayEnvironment } from "solid-relay";
import { ActorPreviewCard } from "~/components/ActorPreviewCard.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.ts";
import type {
  ReactionGroupSection_LoadMoreQuery,
  ReactionGroupSection_LoadMoreQuery$data,
} from "./__generated__/ReactionGroupSection_LoadMoreQuery.graphql.ts";

export interface ReactionGroupReactor {
  readonly id: string;
  readonly " $fragmentSpreads": import("relay-runtime").FragmentRefs<"ActorPreviewCard_actor">;
}

export interface ReactionGroupSectionProps {
  /** Global Node ID of the post (Relay-encoded). */
  postNodeId: string;
  /** Total reactor count for this group, taken from the server. */
  totalCount: number;
  /** Initial reactor nodes already loaded by the parent page query. */
  initialReactors: readonly ReactionGroupReactor[];
  /** Pagination cursor of the last reactor in `initialReactors`. */
  initialEndCursor: string | null;
  /** Whether the parent query already exhausted the reactors. */
  initialHasNextPage: boolean;
  /** Key for the reaction group — exactly one of these is non-null. */
  emoji: string | null;
  /** Custom-emoji Node ID (Relay-encoded) when this is a custom group. */
  customEmojiNodeId: string | null;
  /** Rendered above the reactor list — the emoji, custom image, etc. */
  header: import("solid-js").JSX.Element;
}

const ReactionGroupLoadMoreQuery = graphql`
  query ReactionGroupSection_LoadMoreQuery(
    $postId: ID!
    $emoji: String
    $customEmojiId: ID
    $after: String
    $first: Int!
    $actingAccountId: ID
  ) {
    node(id: $postId) {
      ... on Post {
        reactionGroup(emoji: $emoji, customEmojiId: $customEmojiId) {
          reactors(first: $first, after: $after) {
            totalCount
            edges {
              node {
                id
                ...ActorPreviewCard_actor
                  @arguments(actingAccountId: $actingAccountId)
              }
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    }
  }
`;

/**
 * One reaction group, with inline pagination of additional reactors.
 *
 * Shared by `/reactions` on notes and articles.  The parent page
 * query fetches the first ~20 reactors per group; this component
 * surfaces a "Load more" button that fires
 * `ReactionGroupSection_LoadMoreQuery` (a singular
 * `Post.reactionGroup(emoji|customEmojiId)` query) and appends each
 * page's edges into local state.  No `@refetchable` on the group
 * itself because `ReactionGroup` doesn't implement `Node`, so the
 * refetch happens via the addressable `Post` plus the group's key.
 */
export function ReactionGroupSection(props: ReactionGroupSectionProps) {
  const { t, i18n } = useLingui();
  const actingAccount = useActingAccount();
  const environment = useRelayEnvironment();
  const [extra, setExtra] = createSignal<readonly ReactionGroupReactor[]>([]);
  const [endCursor, setEndCursor] = createSignal<string | null>(
    props.initialEndCursor,
  );
  const [hasNext, setHasNext] = createSignal<boolean>(props.initialHasNextPage);
  const [loadingState, setLoadingState] = createSignal<
    "idle" | "loading" | "errored"
  >("idle");

  const allReactors = () => [...props.initialReactors, ...extra()];

  // `fetchQuery` itself doesn't retain the records it writes — without
  // an explicit `environment.retain(operation)` Relay is free to GC the
  // fragment refs we just appended.  Track two disposable sets:
  //
  //   - `retainers` — `environment.retain` disposables that keep the
  //     loaded records alive for as long as this component is mounted.
  //     Disposed on unmount (and on error, since those records won't be
  //     consumed).
  //   - `subscriptions` — the `fetchQuery` subscriptions themselves, so
  //     an in-flight request can be cancelled when the component
  //     unmounts mid-load and its `next`/`error`/`complete` callbacks
  //     stop firing on a destroyed component.
  const retainers = new Set<Disposable>();
  const subscriptions = new Set<{ unsubscribe(): void }>();
  onCleanup(() => {
    for (const r of retainers) r.dispose();
    retainers.clear();
    for (const s of subscriptions) s.unsubscribe();
    subscriptions.clear();
  });

  function onLoadMore() {
    if (loadingState() === "loading") return;
    setLoadingState("loading");
    const variables = {
      postId: props.postNodeId,
      emoji: props.emoji,
      customEmojiId: props.customEmojiNodeId,
      after: endCursor(),
      first: 20,
      actingAccountId: actingAccount.selectedActingAccountId() ?? null,
    };
    const operation = createOperationDescriptor(
      getRequest(ReactionGroupLoadMoreQuery),
      variables,
    );
    const retain = environment().retain(operation);
    retainers.add(retain);
    let subEntry: { unsubscribe(): void } | null = null;
    const subscription = fetchQuery<ReactionGroupSection_LoadMoreQuery>(
      environment(),
      ReactionGroupLoadMoreQuery,
      variables,
    ).subscribe({
      next(data: ReactionGroupSection_LoadMoreQuery$data) {
        const node = data.node;
        const group =
          node != null && "reactionGroup" in node ? node.reactionGroup : null;
        const connection =
          group != null && "reactors" in group ? group.reactors : null;
        if (connection == null) {
          setHasNext(false);
          return;
        }
        const newNodes: ReactionGroupReactor[] = connection.edges.flatMap(
          (e) => (e.node == null ? [] : [e.node as ReactionGroupReactor]),
        );
        setExtra((prev) => [...prev, ...newNodes]);
        setEndCursor(connection.pageInfo.endCursor ?? null);
        setHasNext(connection.pageInfo.hasNextPage);
      },
      error(_err: unknown) {
        setLoadingState("errored");
        // The retain is useless if the load failed — nothing was
        // written to the store, so release it immediately.
        retainers.delete(retain);
        retain.dispose();
        if (subEntry != null) subscriptions.delete(subEntry);
      },
      complete() {
        if (loadingState() !== "errored") setLoadingState("idle");
        // Keep the retain alive: the appended reactor fragment refs
        // still need their store records.  Drop only the subscription
        // tracker.
        if (subEntry != null) subscriptions.delete(subEntry);
      },
    });
    subEntry = subscription;
    subscriptions.add(subEntry);
  }

  return (
    <section>
      {props.header}
      <Show
        when={allReactors().length > 0}
        fallback={
          <p class="px-4 py-3 text-sm text-muted-foreground">
            {t`No reactors loaded.`}
          </p>
        }
      >
        <ul class="divide-y">
          <For each={allReactors()}>
            {(actor) => (
              <li>
                <ActorPreviewCard $actor={actor} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={hasNext()}>
        <button
          type="button"
          on:click={loadingState() === "loading" ? undefined : onLoadMore}
          disabled={loadingState() === "loading"}
          class="block w-full cursor-pointer border-t px-4 py-3 text-center text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Switch>
            <Match when={loadingState() === "loading"}>
              {t`Loading more reactors…`}
            </Match>
            <Match when={loadingState() === "errored"}>
              {t`Failed to load more reactors; click to retry`}
            </Match>
            <Match when={loadingState() === "idle"}>
              {i18n._(
                msg`${plural(
                  Math.max(0, props.totalCount - allReactors().length),
                  {
                    one: "Load # more reactor",
                    other: "Load # more reactors",
                  },
                )}`,
              )}
            </Match>
          </Switch>
        </button>
      </Show>
    </section>
  );
}
