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
import { EngagementTabs } from "~/components/EngagementTabs.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { PostCard } from "~/components/PostCard.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { Title } from "~/components/Title.tsx";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";
import type {
  quotesNoteEngagementQuery,
  quotesNoteEngagementQuery$data,
} from "./__generated__/quotesNoteEngagementQuery.graphql.ts";
import type { quotesNoteEngagement_post$key } from "./__generated__/quotesNoteEngagement_post.graphql.ts";

const QUOTES_QUERY_KEY = "loadQuotesQuery";

const quotesNoteEngagementQuery = graphql`
  query quotesNoteEngagementQuery($handle: String!, $noteId: UUID!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $noteId) {
        __typename
        engagementStats {
          shares
          quotes
          reactions
        }
        ...PostCard_post
        ...quotesNoteEngagement_post
      }
    }
  }
`;

const loadQuotesQuery = routePreloadedQuery(
  (username: string, noteId: Uuid) =>
    loadQuery<quotesNoteEngagementQuery>(
      useRelayEnvironment()(),
      quotesNoteEngagementQuery,
      { handle: username, noteId },
      { fetchPolicy: "store-and-network" },
    ),
  QUOTES_QUERY_KEY,
);

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    const username = decodeURIComponent(args.params.handle!);
    const noteId = args.params.noteId!;
    if (!validateUuid(noteId)) return;
    void loadQuotesQuery(username.replace(/^@/, ""), noteId);
  },
} satisfies RouteDefinition;

export default function QuotesPage() {
  const params = useParams();
  return (
    <Show
      when={validateUuid(params.noteId!)}
      fallback={<NotFoundPage embedded />}
    >
      <QuotesPageLoaded
        noteId={params.noteId! as Uuid}
        handle={decodeURIComponent(params.handle!)}
      />
    </Show>
  );
}

type QuotesPagePost = NonNullable<
  NonNullable<quotesNoteEngagementQuery$data["actorByHandle"]>["postByUuid"]
>;

function QuotesPageLoaded(props: { noteId: Uuid; handle: string }) {
  const username = () => props.handle.replace(/^@/, "");
  const data = createPreloadedQuery<quotesNoteEngagementQuery>(
    quotesNoteEngagementQuery,
    () => loadQuotesQuery(username(), props.noteId),
  );
  // Notes, questions, and articles can all be reached through the
  // `[noteId]` route.  Local articles additionally expose a prettier
  // permalink at `[idOrYear]/[slug]`, but remote articles only have
  // this UUID-based path, so accept any post type returned by
  // `postByUuid` here.
  const post = (): QuotesPagePost | null =>
    data()?.actorByHandle?.postByUuid ?? null;
  // Re-encode the routing-sensitive delimiters in the decoded handle
  // so the tab links can't be broken by a malformed federated handle.
  const base = () => `/${encodeHandleSegment(props.handle)}/${props.noteId}`;
  return (
    <Show when={data() != null}>
      <Show keyed when={post()} fallback={<NotFoundPage embedded />}>
        {(p) => <QuotesPageBody post={p} base={base()} />}
      </Show>
    </Show>
  );
}

function QuotesPageBody(props: { post: QuotesPagePost; base: string }) {
  const { t } = useLingui();
  return (
    <NarrowContainer>
      <Title>{t`Quotes`}</Title>
      <div class="my-4 space-y-4">
        <div class="border rounded-xl overflow-hidden">
          <PostCard $post={props.post} />
        </div>
        <EngagementTabs
          base={props.base}
          active="quotes"
          shares={props.post.engagementStats.shares}
          quotes={props.post.engagementStats.quotes}
          reactions={props.post.engagementStats.reactions}
        />
        <div class="border rounded-xl overflow-hidden">
          <QuotesList $post={props.post as quotesNoteEngagement_post$key} />
        </div>
      </div>
    </NarrowContainer>
  );
}

function QuotesList(props: { $post: quotesNoteEngagement_post$key }) {
  const { t } = useLingui();
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");
  const quotes = createPaginationFragment(
    graphql`
      fragment quotesNoteEngagement_post on Post
        @refetchable(queryName: "quotesNoteEngagementPaginationQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
        )
      {
        quotes(after: $cursor, first: $count)
          @connection(key: "QuotesNoteEngagement__quotes")
        {
          edges {
            node {
              id
              ...PostCard_post
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
  const edges = () => quotes()?.quotes.edges ?? [];

  function onLoadMore() {
    setLoadingState("loading");
    quotes.loadNext(20, {
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
          {t`No one has quoted this yet.`}
        </p>
      }
    >
      <For each={edges()}>
        {(edge) => (
          <Show keyed when={edge.node}>
            {(quote) => <PostCard $post={quote} />}
          </Show>
        )}
      </For>
      <Show when={quotes.hasNext}>
        <button
          type="button"
          on:click={loadingState() === "loading" ? undefined : onLoadMore}
          disabled={quotes.pending || loadingState() === "loading"}
          class="block w-full cursor-pointer border-t px-4 py-5 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Switch>
            <Match when={quotes.pending || loadingState() === "loading"}>
              {t`Loading more quotes…`}
            </Match>
            <Match when={loadingState() === "errored"}>
              {t`Failed to load more quotes; click to retry`}
            </Match>
            <Match when={loadingState() === "loaded"}>
              {t`Load more quotes`}
            </Match>
          </Switch>
        </button>
      </Show>
    </Show>
  );
}
