import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import {
  createPaginationFragment,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorPreviewCard } from "~/components/ActorPreviewCard.tsx";
import { EngagementTabs } from "~/components/EngagementTabs.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";
import type {
  sharesNoteEngagementQuery,
  sharesNoteEngagementQuery$data,
} from "./__generated__/sharesNoteEngagementQuery.graphql.ts";
import type { sharesNoteEngagement_post$key } from "./__generated__/sharesNoteEngagement_post.graphql.ts";

const SHARES_QUERY_KEY = "loadSharesQuery";

const sharesNoteEngagementQuery = graphql`
  query sharesNoteEngagementQuery($handle: String!, $noteId: UUID!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $noteId) {
        __typename
        engagementStats {
          shares
          quotes
          reactions
        }
        ...sharesNoteEngagement_post
      }
    }
  }
`;

const loadSharesQuery = routePreloadedQuery(
  (username: string, noteId: Uuid) =>
    loadQuery<sharesNoteEngagementQuery>(
      useRelayEnvironment()(),
      sharesNoteEngagementQuery,
      { handle: username, noteId },
      { fetchPolicy: "store-and-network" },
    ),
  SHARES_QUERY_KEY,
);

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    const username = decodeURIComponent(args.params.handle!);
    const noteId = args.params.noteId!;
    if (!validateUuid(noteId)) return;
    void loadSharesQuery(username.replace(/^@/, ""), noteId);
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
        handle={decodeURIComponent(params.handle!)}
      />
    </Show>
  );
}

type SharesPagePost = NonNullable<
  NonNullable<sharesNoteEngagementQuery$data["actorByHandle"]>["postByUuid"]
>;

function SharesPageLoaded(props: { noteId: Uuid; handle: string }) {
  const username = () => props.handle.replace(/^@/, "");
  const data = createPreloadedQuery<sharesNoteEngagementQuery>(
    sharesNoteEngagementQuery,
    () => loadSharesQuery(username(), props.noteId),
  );
  // The `[noteId]` route is reserved for notes and questions — articles
  // have their own permalink/engagement routes under `[idOrYear]/[slug]`,
  // so treat an article UUID landing here as a 404 rather than render an
  // empty/broken engagement view.
  const post = (): SharesPagePost | null => {
    const p = data()?.actorByHandle?.postByUuid ?? null;
    if (p == null) return null;
    if (p.__typename !== "Note" && p.__typename !== "Question") return null;
    return p;
  };
  // The current URL's `/{handle}/{noteId}` is itself the canonical
  // permalink base for the engagement tabs, regardless of whether the
  // post is a note or question (and irrespective of any `sourceId`
  // alias).  Using it directly keeps the tabs working for every post
  // type the parent route already loads.
  const base = () => `/${props.handle}/${props.noteId}`;
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
      <div class="my-4 border rounded-xl overflow-hidden">
        <EngagementTabs
          base={props.base}
          active="shares"
          shares={props.post.engagementStats.shares}
          quotes={props.post.engagementStats.quotes}
          reactions={props.post.engagementStats.reactions}
        />
        <SharesList $post={props.post as sharesNoteEngagement_post$key} />
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
                ...ActorPreviewCard_actor
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
