import { sortReactionGroups } from "@hackerspub/models/emoji";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { type RouteDefinition, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { EngagementTabs } from "~/components/EngagementTabs.tsx";
import { PostCard } from "~/components/PostCard.tsx";
import { ReactionGroupSection } from "~/components/ReactionGroupSection.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { Title } from "~/components/Title.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type {
  reactionsNoteEngagementQuery,
  reactionsNoteEngagementQuery$data,
} from "./__generated__/reactionsNoteEngagementQuery.graphql.ts";

const REACTIONS_QUERY_KEY = "loadReactionsQuery";

const reactionsNoteEngagementQuery = graphql`
  query reactionsNoteEngagementQuery(
    $handle: String!
    $noteId: UUID!
    $actingAccountId: ID
  ) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $noteId, actingAccountId: $actingAccountId) {
        __typename
        id
        engagementStats {
          shares
          quotes
          reactions
        }
        ...PostCard_post @arguments(actingAccountId: $actingAccountId)
        reactionGroups {
          __typename
          ... on EmojiReactionGroup {
            emoji
            reactorsPage: reactors(first: 20) {
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
          ... on CustomEmojiReactionGroup {
            customEmoji {
              id
              name
              imageUrl
            }
            reactorsPage: reactors(first: 20) {
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
  }
`;

const loadReactionsQuery = routePreloadedQuery(
  (username: string, noteId: Uuid, actingAccountId: string | null) =>
    loadQuery<reactionsNoteEngagementQuery>(
      useRelayEnvironment()(),
      reactionsNoteEngagementQuery,
      { handle: username, noteId, actingAccountId },
      { fetchPolicy: "store-and-network" },
    ),
  REACTIONS_QUERY_KEY,
);

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

export default function ReactionsPage() {
  const params = useParams();
  return (
    <Show
      when={validateUuid(params.noteId!)}
      fallback={<NotFoundPage embedded />}
    >
      <ReactionsPageLoaded
        noteId={params.noteId! as Uuid}
        handle={decodeRouteParam(params.handle!)}
      />
    </Show>
  );
}

type ReactionsPagePost = NonNullable<
  NonNullable<reactionsNoteEngagementQuery$data["actorByHandle"]>["postByUuid"]
>;

function ReactionsPageLoaded(props: { noteId: Uuid; handle: string }) {
  const actingAccount = useActingAccount();
  const username = () => props.handle.replace(/^@/, "");
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const data = createStablePreloadedQuery<reactionsNoteEngagementQuery>(
    reactionsNoteEngagementQuery,
    () =>
      loadReactionsQuery(username(), props.noteId, actingAccountId() ?? null),
  );
  // Notes, questions, and articles can all be reached through the
  // `[noteId]` route.  Local articles additionally expose a prettier
  // permalink at `[idOrYear]/[slug]`, but remote articles only have
  // this UUID-based path, so accept any post type returned by
  // `postByUuid` here.
  const post = (): ReactionsPagePost | null =>
    data()?.actorByHandle?.postByUuid ?? null;
  // Re-encode the routing-sensitive delimiters in the decoded handle
  // so the tab links can't be broken by a malformed federated handle.
  const base = () => `/${encodeHandleSegment(props.handle)}/${props.noteId}`;
  return (
    <Show when={data() != null}>
      <Show keyed when={post()} fallback={<NotFoundPage embedded />}>
        {(p) => <ReactionsPageBody post={p} base={base()} />}
      </Show>
    </Show>
  );
}

// Drop Relay's forward-compatible "%other" `__typename` branch (which
// lacks `emoji`/`customEmoji`) so the remaining union satisfies
// `sortReactionGroups`'s generic constraint and the sub-component
// can safely narrow on the two known shapes.
type ReactionGroup = Exclude<
  ReactionsPagePost["reactionGroups"][number],
  { readonly __typename: "%other" }
>;

function ReactionsPageBody(props: { post: ReactionsPagePost; base: string }) {
  const { t } = useLingui();
  // Sort the same way the engagement bar and emoji popover do so the
  // group order stays consistent across views.  Filter out the
  // forward-compatible "%other" branch as well as any group whose
  // `reactorsPage` is missing — that happens transiently when the
  // emoji-reaction popover's optimistic store updater synthesises a
  // new group with `reactors` (no args) but not the page query's
  // `reactors(first: 20)` linked record; rendering would otherwise
  // crash dereferencing `reactorsPage.totalCount`.  The page will
  // pick the group up on its next `store-and-network` refetch.
  const knownGroups = () =>
    props.post.reactionGroups.filter(
      (g): g is ReactionGroup =>
        (g.__typename === "EmojiReactionGroup" ||
          g.__typename === "CustomEmojiReactionGroup") &&
        g.reactorsPage != null,
    );
  const groups = () => sortReactionGroups(knownGroups());
  return (
    <NarrowContainer>
      <Title>{t`Reactions`}</Title>
      <div class="my-4 space-y-4">
        <div class="border rounded-xl overflow-hidden">
          <PostCard $post={props.post} />
        </div>
        <EngagementTabs
          base={props.base}
          active="reactions"
          shares={props.post.engagementStats.shares}
          quotes={props.post.engagementStats.quotes}
          reactions={props.post.engagementStats.reactions}
        />
        <Show
          when={groups().length > 0}
          fallback={
            <p class="p-6 text-center text-sm text-muted-foreground border rounded-xl">
              {t`No reactions yet.`}
            </p>
          }
        >
          <div class="divide-y border rounded-xl overflow-hidden">
            <For each={groups()}>
              {(group) => (
                <ReactionGroupSection
                  postNodeId={props.post.id}
                  totalCount={group.reactorsPage.totalCount}
                  initialReactors={group.reactorsPage.edges.flatMap((e) =>
                    e.node == null ? [] : [e.node],
                  )}
                  initialEndCursor={
                    group.reactorsPage.pageInfo.endCursor ?? null
                  }
                  initialHasNextPage={group.reactorsPage.pageInfo.hasNextPage}
                  emoji={
                    group.__typename === "EmojiReactionGroup"
                      ? group.emoji
                      : null
                  }
                  customEmojiNodeId={
                    group.__typename === "CustomEmojiReactionGroup"
                      ? group.customEmoji.id
                      : null
                  }
                  header={
                    <header class="flex items-center gap-2 bg-muted/40 px-4 py-2 text-sm font-medium">
                      <Show
                        when={group.__typename === "EmojiReactionGroup"}
                        fallback={
                          <Show
                            keyed
                            when={
                              group.__typename === "CustomEmojiReactionGroup"
                                ? group.customEmoji
                                : null
                            }
                          >
                            {(emoji) => (
                              <img
                                src={emoji.imageUrl}
                                alt={emoji.name}
                                class="size-5"
                              />
                            )}
                          </Show>
                        }
                      >
                        <span class="text-base leading-none">
                          {group.__typename === "EmojiReactionGroup"
                            ? group.emoji
                            : ""}
                        </span>
                      </Show>
                      <span class="text-muted-foreground">
                        {group.reactorsPage.totalCount}
                      </span>
                    </header>
                  }
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </NarrowContainer>
  );
}
