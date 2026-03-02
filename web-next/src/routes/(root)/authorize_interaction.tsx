import {
  query,
  type RouteDefinition,
  useNavigate,
  useSearchParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createEffect, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { FollowButton } from "~/components/FollowButton.tsx";
import { Title } from "~/components/Title.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { authorizeInteractionPageQuery } from "./__generated__/authorizeInteractionPageQuery.graphql.ts";

export const route = {
  preload(args) {
    const uri = new URLSearchParams(args.location.search).get("uri") ?? "";
    if (uri) {
      void loadPageQuery(uri);
    }
  },
} satisfies RouteDefinition;

const authorizeInteractionPageQuery = graphql`
  query authorizeInteractionPageQuery($uri: String!) {
    viewer {
      username
    }
    actorByHandle(handle: $uri) {
      name
      rawName
      username
      handle
      avatarUrl
      avatarInitials
      url
      iri
      instance {
        host
      }
      ...FollowButton_actor
    }
  }
`;

const loadPageQuery = query(
  (uri: string) =>
    loadQuery<authorizeInteractionPageQuery>(
      useRelayEnvironment()(),
      authorizeInteractionPageQuery,
      { uri },
    ),
  "loadAuthorizeInteractionPageQuery",
);

export default function AuthorizeInteractionPage() {
  const { t } = useLingui();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const uri = () => searchParams.uri as string | undefined;

  const data = createPreloadedQuery<authorizeInteractionPageQuery>(
    authorizeInteractionPageQuery,
    () => {
      const u = uri();
      if (!u) {
        return loadPageQuery("");
      }
      return loadPageQuery(u);
    },
  );

  createEffect(() => {
    const result = data();
    if (!result) return;
    if (!result.viewer && uri()) {
      const currentUrl = `/authorize_interaction?uri=${
        encodeURIComponent(uri()!)
      }`;
      navigate(`/sign?next=${encodeURIComponent(currentUrl)}`, {
        replace: true,
      });
    }
  });

  return (
    <div class="p-4">
      <Title>{t`Follow from your account`}</Title>
      <div class="max-w-2xl mx-auto">
        <Show
          when={uri()}
          fallback={
            <div class="rounded-lg border p-6" role="alert">
              <p class="text-destructive">{t`No user URI provided.`}</p>
            </div>
          }
        >
          <Show when={data()}>
            {(result) => (
              <Show when={result().viewer}>
                <div class="rounded-lg border p-6 space-y-4">
                  <h1 class="text-lg font-semibold">
                    {t`Follow from your account`}
                  </h1>

                  <Show
                    when={result().actorByHandle}
                    fallback={
                      <div class="rounded-md border p-4">
                        <code class="text-sm break-all">{uri()}</code>
                      </div>
                    }
                  >
                    {(actor) => (
                      <>
                        <p class="text-sm text-muted-foreground">
                          {t`You are about to follow ${
                            actor().name ?? actor().handle
                          }.`}
                        </p>

                        <div class="rounded-md border p-4">
                          <div class="flex items-start gap-3">
                            <Avatar class="size-12 flex-shrink-0">
                              <AvatarImage src={actor().avatarUrl} />
                              <AvatarFallback>
                                {actor().avatarInitials}
                              </AvatarFallback>
                            </Avatar>
                            <div class="flex-1 min-w-0">
                              <Show when={actor().name}>
                                {(name) => (
                                  <h2
                                    class="font-semibold truncate"
                                    innerHTML={name()}
                                    aria-label={actor().rawName ?? actor().username}
                                  />
                                )}
                              </Show>
                              <p class="text-sm text-muted-foreground truncate">
                                {actor().handle}
                              </p>
                              <Show when={actor().instance}>
                                {(instance) => (
                                  <p class="text-xs text-muted-foreground mt-1">
                                    {instance().host}
                                  </p>
                                )}
                              </Show>
                            </div>
                          </div>
                        </div>

                        <div class="flex items-center justify-between">
                          <p class="text-sm text-muted-foreground">
                            {t`Signed in as`}{" "}
                            <strong>@{result().viewer?.username}</strong>
                          </p>
                          <div class="flex gap-3 items-center justify-between">
                            <Button
                              variant="outline"
                              as="a"
                              href={actor().url ?? actor().iri}
                            >
                              {t`Cancel`}
                            </Button>
                            <FollowButton
                              $actor={actor()}
                              onFollowed={() =>
                                navigate(`/${actor().handle}`, {
                                  replace: true,
                                })}
                            />
                          </div>
                        </div>
                      </>
                    )}
                  </Show>
                </div>
              </Show>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
