import { Navigate, useNavigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import { AdminTabs } from "~/components/AdminTabs.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { Title } from "~/components/Title.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { refreshPageMutation } from "./__generated__/refreshPageMutation.graphql.ts";
import type { refreshPageQuery } from "./__generated__/refreshPageQuery.graphql.ts";

const refreshPageQuery = graphql`
  query refreshPageQuery {
    viewer {
      moderator
    }
  }
`;

const loadAdminRefreshPageQuery = routePreloadedQuery(
  () =>
    loadQuery<refreshPageQuery>(
      useRelayEnvironment()(),
      refreshPageQuery,
      {},
      { fetchPolicy: "network-only" },
    ),
  "loadAdminRefreshPageQuery",
);

const refreshPageMutation = graphql`
  mutation refreshPageMutation($uri: String!) {
    refreshRemoteObject(input: { uri: $uri }) {
      __typename
      ... on RefreshRemoteObjectPayload {
        actor {
          id
          rawName
          handle
        }
        post {
          id
          uuid
          actor {
            rawName
            handle
          }
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

interface RefreshedActor {
  readonly rawName: string | null | undefined;
  readonly handle: string;
}

interface RefreshedPost {
  readonly uuid: string;
  readonly actor: {
    readonly rawName: string | null | undefined;
    readonly handle: string;
  };
}

export default function AdminRefreshPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const data = createStablePreloadedQuery<refreshPageQuery>(
    refreshPageQuery,
    () => loadAdminRefreshPageQuery(),
  );
  const [commitRefresh] = createMutation<refreshPageMutation>(
    refreshPageMutation,
  );
  const [uriInput, setUriInput] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [refreshedActor, setRefreshedActor] = createSignal<
    RefreshedActor | null
  >(null);
  const [refreshedPost, setRefreshedPost] = createSignal<RefreshedPost | null>(
    null,
  );

  function onSubmit(event: Event) {
    event.preventDefault();
    const uri = uriInput().trim();
    if (uri.length < 1 || submitting()) return;
    setSubmitting(true);
    commitRefresh({
      variables: { uri },
      onCompleted(response) {
        setSubmitting(false);
        const result = response.refreshRemoteObject;
        if (result.__typename === "RefreshRemoteObjectPayload") {
          setRefreshedActor(result.actor ?? null);
          setRefreshedPost(result.post ?? null);
          showToast({ title: t`Refreshed from origin.` });
        } else if (result.__typename === "InvalidInputError") {
          showToast({
            title: t`Could not resolve that as a remote object.`,
            variant: "destructive",
          });
        } else if (result.__typename === "NotAuthenticatedError") {
          navigate("/sign?next=%2Fadmin%2Frefresh", { replace: true });
        } else {
          showToast({
            title: t`Only moderators can refresh remote objects.`,
            variant: "destructive",
          });
        }
      },
      onError(error) {
        setSubmitting(false);
        showToast({
          title: t`Failed to refresh from origin.`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "destructive",
        });
      },
    });
  }

  return (
    <NarrowContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · Refresh remote object`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            keyed
            when={data.viewer?.moderator}
            fallback={data.viewer == null
              ? <Navigate href="/sign?next=%2Fadmin%2Frefresh" />
              : <Navigate href="/" />}
          >
            {(_) => (
              <>
                <AdminTabs selected="refresh" />
                <h1 class="mb-4 mt-4 text-2xl font-semibold tracking-tight">
                  {t`Refresh remote object`}
                </h1>
                <Card>
                  <CardHeader>
                    <CardTitle>{t`Refresh a remote actor or post`}</CardTitle>
                    <CardDescription>
                      {t`Re-fetch a remote actor or post from its origin server and overwrite the cached copy. Enter a fediverse handle, profile URL, or ActivityPub IRI.`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent class="space-y-4">
                    <form
                      class="flex flex-col gap-3 sm:flex-row sm:items-end"
                      on:submit={onSubmit}
                    >
                      <TextField class="grid flex-1 gap-1.5">
                        <TextFieldLabel for="refresh-uri">
                          {t`Handle, URL, or IRI`}
                        </TextFieldLabel>
                        <TextFieldInput
                          id="refresh-uri"
                          type="text"
                          placeholder="@user@example.com"
                          value={uriInput()}
                          onInput={(e) => setUriInput(e.currentTarget.value)}
                        />
                      </TextField>
                      <Button
                        type="submit"
                        disabled={submitting() || uriInput().trim().length < 1}
                      >
                        {submitting() ? t`Refreshing…` : t`Refresh`}
                      </Button>
                    </form>
                    <Show when={refreshedActor()}>
                      {(actor) => (
                        <p class="text-sm">
                          <span class="text-muted-foreground">
                            {t`Last refreshed:`}
                          </span>{" "}
                          <a class="underline" href={`/${actor().handle}`}>
                            {actor().rawName ?? actor().handle}
                          </a>{" "}
                          <span class="text-muted-foreground">
                            {actor().handle}
                          </span>
                        </p>
                      )}
                    </Show>
                    <Show when={refreshedPost()}>
                      {(post) => (
                        <p class="text-sm">
                          <span class="text-muted-foreground">
                            {t`Last refreshed:`}
                          </span>{" "}
                          <a
                            class="underline"
                            href={`/${post().actor.handle}/${post().uuid}`}
                          >
                            {t`Post by ${
                              post().actor.rawName ?? post().actor.handle
                            }`}
                          </a>
                        </p>
                      )}
                    </Show>
                  </CardContent>
                </Card>
              </>
            )}
          </Show>
        )}
      </Show>
    </NarrowContainer>
  );
}
