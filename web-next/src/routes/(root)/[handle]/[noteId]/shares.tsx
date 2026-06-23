import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { type RouteDefinition, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import {
  createPaginationFragment,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorPreviewCard } from "~/components/ActorPreviewCard.tsx";
import { EngagementTabs } from "~/components/EngagementTabs.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { PostCard } from "~/components/PostCard.tsx";
import { Title } from "~/components/Title.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type {
  sharesNoteEngagementQuery,
  sharesNoteEngagementQuery$data,
} from "./__generated__/sharesNoteEngagementQuery.graphql.ts";
import type { sharesNoteEngagement_post$key } from "./__generated__/sharesNoteEngagement_post.graphql.ts";

const SHARES_QUERY_KEY = "loadSharesQuery";

const sharesNoteEngagementQuery = graphql`
  query sharesNoteEngagementQuery(
    $handle: String!
    $noteId: UUID!
    $actingAccountId: ID
  ) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $noteId) {
        __typename
        engagementStats {
          shares
          quotes
          reactions
        }
        ...PostCard_post
        ...sharesNoteEngagement_post @arguments(
          actingAccountId: $actingAccountId
        )
      }
    }
  }
`;

const loadSharesQuery = routePreloadedQuery(
  (username: string, noteId: Uuid, actingAccountId: string | null) =>
    loadQuery<sharesNoteEngagementQuery>(
      useRelayEnvironment()(),
      sharesNoteEngagementQuery,
      { handle: username, noteId, actingAccountId },
      { fetchPolicy: "store-and-network" },
    ),
  SHARES_QUERY_KEY,
);

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

export default function SharesPage() {
  const params = useParams();
  return (
    <Show
      when={validateUuid(params.noteId!)}
      fallback={<NotFoundPage embedded />}
    >
      <SharesPageLoaded
        noteId={params.noteId! as Uuid}
        handle={decodeRouteParam(params.handle!)}
      />
    </Show>
  );
}

type SharesPagePost = NonNullable<
  NonNullable<sharesNoteEngagementQuery$data["actorByHandle"]>["postByUuid"]
>;

function SharesPageLoaded(props: { noteId: Uuid; handle: string }) {
  const actingAccount = useActingAccount();
  const username = () => props.handle.replace(/^@/, "");
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const data = createStablePreloadedQuery<sharesNoteEngagementQuery>(
    sharesNoteEngagementQuery,
    () =>
      loadSharesQuery(
        username(),
        props.noteId,
        actingAccountId() ?? null,
      ),
  );
  // Notes, questions, and articles can all be reached through the
  // `[noteId]` route.  Local articles additionally expose a prettier
  // permalink at `[idOrYear]/[slug]`, but remote articles only have
  // this UUID-based path, so accept any post type returned by
  // `postByUuid` here.
  const post = (): SharesPagePost | null =>
    data()?.actorByHandle?.postByUuid ?? null;
  // `props.handle` is the decoded `[handle]` segment (e.g.
  // `@user@instance.tld`).  Re-encode the routing-sensitive delimiters
  // when splicing it back into a URL so a malformed handle can't
  // escape the path segment of the tab links.
  const base = () => `/${encodeHandleSegment(props.handle)}/${props.noteId}`;
  return (
    <Show when={data() != null}>
      <Show keyed when={post()} fallback={<NotFoundPage embedded />}>
        {(p) => <SharesPageBody post={p} base={base()} />}
      </Show>
    </Show>
  );
}

function SharesPageBody(props: { post: SharesPagePost; base: string }) {
  const { t } = useLingui();
  return (
    <NarrowContainer>
      <Title>{t`Shares`}</Title>
      <div class="my-4 space-y-4">
        <div class="border rounded-xl overflow-hidden">
          <PostCard $post={props.post} />
        </div>
        <EngagementTabs
          base={props.base}
          active="shares"
          shares={props.post.engagementStats.shares}
          quotes={props.post.engagementStats.quotes}
          reactions={props.post.engagementStats.reactions}
        />
        <div class="border rounded-xl overflow-hidden">
          <SharesList $post={props.post as sharesNoteEngagement_post$key} />
        </div>
      </div>
    </NarrowContainer>
  );
}

function SharesList(props: { $post: sharesNoteEngagement_post$key }) {
  const { t } = useLingui();
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");
  const shares = createPaginationFragment(
    graphql`
      fragment sharesNoteEngagement_post on Post
        @refetchable(queryName: "sharesNoteEngagementPaginationQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 30 }
          actingAccountId: { type: "ID", defaultValue: null }
        )
      {
        shares(after: $cursor, first: $count)
          @connection(key: "SharesNoteEngagement__shares")
        {
          edges {
            node {
              id
              actor {
                id
                ...ActorPreviewCard_actor @arguments(
                  actingAccountId: $actingAccountId
                )
              }
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$post,
  );
  const edges = () => shares()?.shares.edges ?? [];

  function onLoadMore() {
    setLoadingState("loading");
    shares.loadNext(30, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <Show
      when={edges().length > 0}
      fallback={
        <p class="p-6 text-center text-sm text-muted-foreground">
          {t`No one has shared this yet.`}
        </p>
      }
    >
      <ul class="divide-y">
        <For each={edges()}>
          {(edge) => (
            <Show keyed when={edge.node?.actor}>
              {(actor) => (
                <li>
                  <ActorPreviewCard $actor={actor} />
                </li>
              )}
            </Show>
          )}
        </For>
      </ul>
      <Show when={shares.hasNext}>
        <button
          type="button"
          on:click={loadingState() === "loading" ? undefined : onLoadMore}
          disabled={shares.pending || loadingState() === "loading"}
          class="block w-full cursor-pointer border-t px-4 py-5 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Switch>
            <Match when={shares.pending || loadingState() === "loading"}>
              {t`Loading more shares…`}
            </Match>
            <Match when={loadingState() === "errored"}>
              {t`Failed to load more shares; click to retry`}
            </Match>
            <Match when={loadingState() === "loaded"}>
              {t`Load more shares`}
            </Match>
          </Switch>
        </button>
      </Show>
    </Show>
  );
}
