import { sortReactionGroups } from "@hackerspub/models/emoji";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import {
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
  reactionsNoteEngagementQuery,
  reactionsNoteEngagementQuery$data,
} from "./__generated__/reactionsNoteEngagementQuery.graphql.ts";

const REACTIONS_QUERY_KEY = "loadReactionsQuery";

const reactionsNoteEngagementQuery = graphql`
  query reactionsNoteEngagementQuery($handle: String!, $noteId: UUID!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $noteId) {
        __typename
        engagementStats {
          shares
          quotes
          reactions
        }
        reactionGroups {
          __typename
          ... on EmojiReactionGroup {
            emoji
            reactors(first: 20) {
              totalCount
              edges {
                node {
                  id
                  ...ActorPreviewCard_actor
                }
              }
            }
          }
          ... on CustomEmojiReactionGroup {
            customEmoji {
              id
              name
              imageUrl
            }
            reactors(first: 20) {
              totalCount
              edges {
                node {
                  id
                  ...ActorPreviewCard_actor
                }
              }
            }
          }
        }
      }
    }
  }
`;

const loadReactionsQuery = routePreloadedQuery(
  (username: string, noteId: Uuid) =>
    loadQuery<reactionsNoteEngagementQuery>(
      useRelayEnvironment()(),
      reactionsNoteEngagementQuery,
      { handle: username, noteId },
      { fetchPolicy: "store-and-network" },
    ),
  REACTIONS_QUERY_KEY,
);

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    const username = decodeURIComponent(args.params.handle!);
    const noteId = args.params.noteId!;
    if (!validateUuid(noteId)) return;
    void loadReactionsQuery(username.replace(/^@/, ""), noteId);
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
        handle={decodeURIComponent(params.handle!)}
      />
    </Show>
  );
}

type ReactionsPagePost = NonNullable<
  NonNullable<reactionsNoteEngagementQuery$data["actorByHandle"]>["postByUuid"]
>;

function ReactionsPageLoaded(props: { noteId: Uuid; handle: string }) {
  const username = () => props.handle.replace(/^@/, "");
  const data = createPreloadedQuery<reactionsNoteEngagementQuery>(
    reactionsNoteEngagementQuery,
    () => loadReactionsQuery(username(), props.noteId),
  );
  // The `[noteId]` route is reserved for notes and questions — articles
  // have their own permalink/engagement routes under `[idOrYear]/[slug]`,
  // so treat an article UUID landing here as a 404 rather than render an
  // empty/broken engagement view.
  const post = (): ReactionsPagePost | null => {
    const p = data()?.actorByHandle?.postByUuid ?? null;
    if (p == null) return null;
    if (p.__typename !== "Note" && p.__typename !== "Question") return null;
    return p;
  };
  const base = () => `/${props.handle}/${props.noteId}`;
  return (
    <Show when={data() != null}>
      <Show keyed when={post()} fallback={<NotFoundPage embedded />}>
        {(p) => <ReactionsPageBody post={p} base={base()} />}
      </Show>
    </Show>
  );
}

function ReactionsPageBody(props: { post: ReactionsPagePost; base: string }) {
  const { t } = useLingui();
  // Sort the same way the engagement bar and emoji popover do so the
  // group order stays consistent across views.  Filter out the
  // forward-compatible "%other" branch first.
  const knownGroups = () =>
    props.post.reactionGroups.filter(
      (g): g is ReactionGroup =>
        g.__typename === "EmojiReactionGroup" ||
        g.__typename === "CustomEmojiReactionGroup",
    );
  const groups = () => sortReactionGroups(knownGroups());
  return (
    <NarrowContainer>
      <Title>{t`Reactions`}</Title>
      <div class="my-4 border rounded-xl overflow-hidden">
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
            <p class="p-6 text-center text-sm text-muted-foreground">
              {t`No reactions yet.`}
            </p>
          }
        >
          <div class="divide-y">
            <For each={groups()}>
              {(group) => <ReactionGroupSection group={group} />}
            </For>
          </div>
        </Show>
      </div>
    </NarrowContainer>
  );
}

// Drop Relay's forward-compatible "%other" `__typename` branch (which
// lacks `emoji`/`customEmoji`) so the remaining union satisfies
// `sortReactionGroups`'s generic constraint and `ReactionGroupSection`
// can safely narrow on the two known shapes.
type ReactionGroup = Exclude<
  ReactionsPagePost["reactionGroups"][number],
  { readonly __typename: "%other" }
>;

function ReactionGroupSection(props: { group: ReactionGroup }) {
  const { t } = useLingui();
  // `reactors` is selected on both inline fragments but the
  // discriminated union also carries a "%other" branch for forward
  // compatibility, so narrow via `"reactors" in` before reading.
  const reactors = () =>
    "reactors" in props.group ? props.group.reactors : null;
  const total = () => reactors()?.totalCount ?? 0;
  const edges = () => reactors()?.edges ?? [];
  const shownCount = () => edges().length;
  const remaining = () => Math.max(0, total() - shownCount());
  return (
    <section>
      <header class="flex items-center gap-2 bg-muted/40 px-4 py-2 text-sm font-medium">
        <Show
          when={props.group.__typename === "EmojiReactionGroup"}
          fallback={
            <Show
              keyed
              when={"customEmoji" in props.group
                ? props.group.customEmoji
                : null}
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
            {"emoji" in props.group ? props.group.emoji : ""}
          </span>
        </Show>
        <span class="text-muted-foreground">{total()}</span>
      </header>
      <Show
        when={edges().length > 0}
        fallback={
          <p class="px-4 py-3 text-sm text-muted-foreground">
            {t`No reactors loaded.`}
          </p>
        }
      >
        <ul class="divide-y">
          <For each={edges()}>
            {(edge) => (
              <Show keyed when={edge.node}>
                {(actor) => (
                  <li>
                    <ActorPreviewCard $actor={actor} />
                  </li>
                )}
              </Show>
            )}
          </For>
        </ul>
      </Show>
      <Show when={remaining() > 0}>
        <p class="px-4 py-2 text-xs text-muted-foreground">
          {t`+${remaining()} more reactor(s) not shown`}
        </p>
      </Show>
    </section>
  );
}
