import { graphql } from "relay-runtime";
import { createMutation } from "solid-relay";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import type { RefreshFromOriginItem_refresh_Mutation } from "./__generated__/RefreshFromOriginItem_refresh_Mutation.graphql.ts";

// Re-selecting the very fragments the surrounding UI renders (the profile card
// and the post cards) lets Relay merge the freshly persisted values into the
// store, so the profile or post the moderator is looking at updates in place
// after a successful refresh. `PostCard_post` is the umbrella post fragment that
// composes the Note, Article, and Question card fragments.
const refreshMutation = graphql`
  mutation RefreshFromOriginItem_refresh_Mutation(
    $uri: String!
    $locale: Locale
  ) {
    refreshRemoteObject(input: { uri: $uri }) {
      __typename
      ... on RefreshRemoteObjectPayload {
        actor {
          id
          ...ProfileCard_actor
        }
        post {
          id
          ...PostCard_post @arguments(locale: $locale)
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
    }
  }
`;

export interface RefreshFromOriginItemProps {
  /** The ActivityPub IRI of the remote actor or post to re-fetch. */
  uri: string;
}

/**
 * A moderator-only dropdown-menu item that force-refreshes a remote actor or
 * post from its origin server. Render it inside a `DropdownMenuContent`, gated
 * on the viewer being a moderator and the target being remote.
 */
export function RefreshFromOriginItem(props: RefreshFromOriginItemProps) {
  const { i18n, t } = useLingui();
  const [commitRefresh, isRefreshing] = createMutation<
    RefreshFromOriginItem_refresh_Mutation
  >(refreshMutation);

  const handleRefresh = () => {
    commitRefresh({
      variables: { uri: props.uri, locale: i18n.locale },
      onCompleted(response) {
        const typename = response.refreshRemoteObject.__typename;
        if (typename === "RefreshRemoteObjectPayload") {
          showToast({ title: t`Refreshed from origin.` });
        } else if (typename === "InvalidInputError") {
          showToast({
            title: t`Could not refresh this from its origin.`,
            variant: "destructive",
          });
        } else if (typename === "NotAuthenticatedError") {
          showToast({
            title: t`You must be signed in.`,
            variant: "destructive",
          });
        } else if (typename === "NotAuthorizedError") {
          showToast({
            title: t`Only moderators can refresh remote objects.`,
            variant: "destructive",
          });
        } else {
          showToast({
            title: t`Failed to refresh from origin.`,
            variant: "destructive",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Failed to refresh from origin.`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <DropdownMenuItem
      class="cursor-pointer"
      disabled={isRefreshing()}
      onSelect={handleRefresh}
    >
      <IconRefreshCw class="size-4" />
      {t`Refresh from origin`}
    </DropdownMenuItem>
  );
}
