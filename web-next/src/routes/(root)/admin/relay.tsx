import { Navigate, revalidate, useNavigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, For, Show } from "solid-js";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import { AdminTabs } from "~/components/AdminTabs.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
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
import type { relayAdminPageQuery } from "./__generated__/relayAdminPageQuery.graphql.ts";
import type { relayAdminSubscribeMutation } from "./__generated__/relayAdminSubscribeMutation.graphql.ts";
import type { relayAdminUnsubscribeMutation } from "./__generated__/relayAdminUnsubscribeMutation.graphql.ts";

const relayAdminPageQuery = graphql`
  query relayAdminPageQuery {
    viewer {
      moderator
    }
    relaySubscriptions {
      id
      accepted
      created
      actor {
        name
        handle
        url
      }
    }
  }
`;

const loadRelayAdminPageQuery = routePreloadedQuery(
  () =>
    loadQuery<relayAdminPageQuery>(
      useRelayEnvironment()(),
      relayAdminPageQuery,
      {},
      { fetchPolicy: "network-only" },
    ),
  "loadRelayAdminPageQuery",
);

const relayAdminSubscribeMutation = graphql`
  mutation relayAdminSubscribeMutation($actorUrl: URL!) {
    subscribeRelay(actorUrl: $actorUrl) {
      __typename
      ... on RelaySubscription {
        id
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

const relayAdminUnsubscribeMutation = graphql`
  mutation relayAdminUnsubscribeMutation($id: ID!) {
    unsubscribeRelay(id: $id) {
      __typename
      ... on UnsubscribeRelayPayload {
        relaySubscriptionId
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

export default function AdminRelayPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const data = createStablePreloadedQuery<relayAdminPageQuery>(
    relayAdminPageQuery,
    () => loadRelayAdminPageQuery(),
  );
  const [subscribe] = createMutation<relayAdminSubscribeMutation>(
    relayAdminSubscribeMutation,
  );
  const [unsubscribe] = createMutation<relayAdminUnsubscribeMutation>(
    relayAdminUnsubscribeMutation,
  );
  const [actorUrl, setActorUrl] = createSignal("");
  const [subscribing, setSubscribing] = createSignal(false);
  const [unsubscribingIds, setUnsubscribingIds] = createSignal<Set<string>>(
    new Set(),
  );
  const stopUnsubscribing = (id: string) =>
    setUnsubscribingIds((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });

  const refresh = () => void revalidate("loadRelayAdminPageQuery");
  const onNotAuthenticated = () =>
    navigate("/sign?next=%2Fadmin%2Frelay", { replace: true });

  function onSubscribe(event: Event) {
    event.preventDefault();
    const url = actorUrl().trim();
    if (url.length < 1) return;
    setSubscribing(true);
    subscribe({
      variables: { actorUrl: url },
      onCompleted(response) {
        setSubscribing(false);
        const result = response.subscribeRelay;
        if (result.__typename === "RelaySubscription") {
          setActorUrl("");
          showToast({ title: t`Subscribed to the relay.` });
          refresh();
        } else if (result.__typename === "InvalidInputError") {
          showToast({
            title: t`That is not a valid relay actor URL.`,
            variant: "error",
          });
        } else if (result.__typename === "NotAuthenticatedError") {
          onNotAuthenticated();
        } else {
          showToast({
            title: t`Not authorized to manage relays.`,
            variant: "error",
          });
        }
      },
      onError(error) {
        setSubscribing(false);
        showToast({
          title: t`Failed to subscribe to the relay.`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "error",
        });
      },
    });
  }

  function onUnsubscribe(id: string) {
    if (unsubscribingIds().has(id)) return;
    setUnsubscribingIds((ids) => new Set(ids).add(id));
    unsubscribe({
      variables: { id },
      onCompleted(response) {
        stopUnsubscribing(id);
        const result = response.unsubscribeRelay;
        // `null` means the subscription was already gone (e.g. a stale page or
        // a concurrent removal): the desired end state is reached, so treat it
        // as success and refresh rather than reporting an error.
        if (result == null || result.__typename === "UnsubscribeRelayPayload") {
          showToast({ title: t`Unsubscribed from the relay.` });
          refresh();
        } else if (result.__typename === "NotAuthenticatedError") {
          onNotAuthenticated();
        } else {
          showToast({
            title: t`Not authorized to manage relays.`,
            variant: "error",
          });
        }
      },
      onError(error) {
        stopUnsubscribing(id);
        showToast({
          title: t`Failed to unsubscribe from the relay.`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "error",
        });
      },
    });
  }

  return (
    <NarrowContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · Relays`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            keyed
            when={data.viewer?.moderator}
            fallback={data.viewer == null
              ? <Navigate href="/sign?next=%2Fadmin%2Frelay" />
              : <Navigate href="/" />}
          >
            {(_) => {
              const subscriptions = () => data.relaySubscriptions ?? [];
              return (
                <div class="space-y-6">
                  <AdminTabs selected="relays" />
                  <h1 class="text-2xl font-semibold tracking-tight">
                    {t`Relays`}
                  </h1>

                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Subscribe to a relay`}</CardTitle>
                      <CardDescription>
                        {t`Make this instance's instance actor follow an ActivityPub relay, so the relay forwards public posts from across the fediverse to this instance. Enter the relay actor's URL, e.g. https://relay.example/actor.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <form
                        class="flex flex-col gap-3 sm:flex-row sm:items-end"
                        on:submit={onSubscribe}
                      >
                        <TextField class="grid flex-1 gap-1.5">
                          <TextFieldLabel for="relay-actor-url">
                            {t`Relay actor URL`}
                          </TextFieldLabel>
                          <TextFieldInput
                            id="relay-actor-url"
                            type="url"
                            placeholder="https://relay.example/actor"
                            value={actorUrl()}
                            onInput={(e) => setActorUrl(e.currentTarget.value)}
                          />
                        </TextField>
                        <Button
                          type="submit"
                          disabled={subscribing() ||
                            actorUrl().trim().length < 1}
                        >
                          {subscribing() ? t`Subscribing…` : t`Subscribe`}
                        </Button>
                      </form>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Subscribed relays`}</CardTitle>
                      <CardDescription>
                        {t`A relay only starts forwarding posts once it has accepted the follow. Until then the subscription stays pending.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Show
                        when={subscriptions().length > 0}
                        fallback={
                          <p class="text-sm text-muted-foreground">
                            {t`Not subscribed to any relays yet.`}
                          </p>
                        }
                      >
                        <ul class="divide-y rounded-md border">
                          <For each={subscriptions()}>
                            {(subscription) => (
                              <li class="flex items-center gap-3 px-3 py-2">
                                <div class="min-w-0 flex-1">
                                  <Show
                                    when={subscription.actor.url}
                                    fallback={
                                      <p class="truncate text-sm font-medium">
                                        {subscription.actor.name ||
                                          subscription.actor.handle}
                                      </p>
                                    }
                                  >
                                    {(url) => (
                                      <a
                                        href={url()}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        class="block truncate text-sm font-medium hover:underline"
                                      >
                                        {subscription.actor.name ||
                                          subscription.actor.handle}
                                      </a>
                                    )}
                                  </Show>
                                  <p class="truncate text-xs text-muted-foreground">
                                    {subscription.actor.handle}
                                    {" · "}
                                    <Show
                                      keyed
                                      when={subscription.accepted}
                                      fallback={t`Pending`}
                                    >
                                      {(accepted) => (
                                        <>
                                          {t`Active since`}{" "}
                                          <Timestamp value={accepted} />
                                        </>
                                      )}
                                    </Show>
                                  </p>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={unsubscribingIds().has(
                                    subscription.id,
                                  )}
                                  on:click={() =>
                                    onUnsubscribe(subscription.id)}
                                >
                                  {t`Unsubscribe`}
                                </Button>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </CardContent>
                  </Card>
                </div>
              );
            }}
          </Show>
        )}
      </Show>
    </NarrowContainer>
  );
}
