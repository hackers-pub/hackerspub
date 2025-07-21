import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorNoteList } from "~/components/ActorNoteList.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { notesPageQuery } from "./__generated__/notesPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    username: /^\@/,
  },
  preload(args) {
    const username = args.params.username;
    void loadPageQuery(username.substring(1));
  },
} satisfies RouteDefinition;

const notesPageQuery = graphql`
  query notesPageQuery($username: String!) {
    accountByUsername(username: $username) {
      username
      actor {
        ...ActorNoteList_notes
        ...ProfileTabs_actor
      }
      ...ProfilePageBreadcrumb_account
      ...ProfileCard_account
    }
  }
`;

const loadPageQuery = query(
  (username: string) =>
    loadQuery<notesPageQuery>(
      useRelayEnvironment()(),
      notesPageQuery,
      { username },
    ),
  "loadProfilePageQuery",
);

export default function ProfileNotesPage() {
  const params = useParams();
  const { t } = useLingui();
  const username = params.username.substring(1);
  const data = createPreloadedQuery<notesPageQuery>(
    notesPageQuery,
    () => loadPageQuery(username),
  );
  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show
            when={data().accountByUsername}
          >
            {(account) => (
              <>
                <ProfilePageBreadcrumb $account={account()}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink current>
                      {t`Notes`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div>
                  <ProfileCard $account={account()} />
                </div>
                <div class="p-4">
                  <ProfileTabs selected="notes" $actor={account().actor} />
                  <ActorNoteList $notes={account().actor} />
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
