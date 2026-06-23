import { Key } from "@solid-primitives/keyed";
import { graphql } from "relay-runtime";
import { Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { NewsDiscussionComposer } from "~/components/NewsDiscussionComposer.tsx";
import { NewsDiscussionThread } from "~/components/NewsDiscussionThread.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { NewsDiscussion_story$key } from "./__generated__/NewsDiscussion_story.graphql.ts";

export interface NewsDiscussionProps {
  $story: NewsDiscussion_story$key;
  targetUuid?: string | null;
}

export function NewsDiscussion(props: NewsDiscussionProps) {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const { onNoteUpdated } = useNoteCompose();
  // Shared across the whole tree so each post renders in exactly one place,
  // even if it is both a root sharing post and a reply/quote elsewhere.
  const rendered = new Set<string>();
  const story = createPaginationFragment(
    graphql`
      fragment NewsDiscussion_story on PostLink
        @refetchable(queryName: "NewsDiscussionQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
          actingAccountId: { type: "ID", defaultValue: null }
        )
      {
        url
        sharingPosts(after: $cursor, first: $count)
          @connection(key: "NewsDiscussion__sharingPosts")
        {
          __id
          edges {
            node {
              id
              ...NewsDiscussionThread_post @arguments(
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
    () => props.$story,
  );

  // Editing an opinion can change or clear the link it shares (the server
  // re-derives `link_id` from the edited content), so a post that no longer
  // shares this link must drop out of the roots.  The edit lands via the
  // shared compose modal, decoupled from this list, so refetch the roots from
  // the network when any note is updated.
  onMount(() => {
    onCleanup(
      onNoteUpdated(() =>
        story.refetch({
          actingAccountId: actingAccountId() ?? null,
        }, { fetchPolicy: "network-only" })
      ),
    );
  });

  return (
    <Show keyed when={story()}>
      {(data) => (
        <>
          <NewsDiscussionComposer
            url={data.url}
            // Prepend the posted opinion into the connection (`@prependNode`)
            // instead of refetching, so only the new row is inserted rather
            // than the whole list being redrawn.
            connectionId={data.sharingPosts.__id}
          />
          <div class="mt-4 mb-10 overflow-hidden border bg-card md:mb-12 md:rounded-lg md:shadow-sm">
            {
              /* Key by post id (not list position): a `refetch` after posting
                 prepends a new opinion, and an unkeyed `<For>` would reuse each
                 row for the shifted post.  The row's own fields update in place,
                 but a child `PostEngagementBar` opens its own fragment
                 subscription off the reference-stable proxy and stays pinned to
                 the post that first occupied the row, showing its engagement
                 counts.  Keying remounts a row only when its post id changes, so
                 each post keeps its own subscription. */
            }
            <Key each={data.sharingPosts.edges} by={(edge) => edge.node.id}>
              {(edge) => (
                <div class="border-b last:border-none">
                  <NewsDiscussionThread
                    $post={edge().node}
                    depth={0}
                    targetUuid={props.targetUuid}
                    rendered={rendered}
                    connections={[data.sharingPosts.__id]}
                  />
                </div>
              )}
            </Key>
            <Show when={story.hasNext}>
              <button
                type="button"
                on:click={story.pending ? undefined : () => story.loadNext(20)}
                disabled={story.pending}
                class="block w-full cursor-pointer px-4 py-6 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Switch fallback={t`Show more sharing posts`}>
                  <Match when={story.pending}>
                    {t`Loading more sharing posts…`}
                  </Match>
                </Switch>
              </button>
            </Show>
            <Show when={data.sharingPosts.edges.length < 1}>
              <div class="px-4 py-16 text-center text-muted-foreground">
                {t`No one has shared this link in a public post yet.`}
              </div>
            </Show>
          </div>
        </>
      )}
    </Show>
  );
}
