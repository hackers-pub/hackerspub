import { useNavigate, useSearchParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createEffect, Show } from "solid-js";
import {
  createFragment,
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
import { routePreloadedQuery } from "~/lib/relayPreload.ts";
import type { authorizeInteractionPageByHandleQuery } from "./__generated__/authorizeInteractionPageByHandleQuery.graphql.ts";
import type { authorizeInteractionPageByUrlQuery } from "./__generated__/authorizeInteractionPageByUrlQuery.graphql.ts";
import type { authorizeInteractionPage_actor$key } from "./__generated__/authorizeInteractionPage_actor.graphql.ts";

function stripAcctPrefix(uri: string): string {
  return uri.replace(/^acct:/i, "");
}

type Lookup =
  | { kind: "handle"; value: string }
  | { kind: "url"; value: string };

function classify(raw: string): Lookup | undefined {
  const uri = stripAcctPrefix(raw);
  if (!uri) return undefined;
  if (URL.canParse(uri)) {
    const parsed = new URL(uri);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return { kind: "url", value: uri };
    }
  }
  return { kind: "handle", value: uri };
}

const authorizeInteractionPageByHandleQuery = graphql`
  query authorizeInteractionPageByHandleQuery($handle: String!) {
    viewer {
      username
    }
    actorByHandle(handle: $handle) {
      ...authorizeInteractionPage_actor
    }
  }
`;

const authorizeInteractionPageByUrlQuery = graphql`
  query authorizeInteractionPageByUrlQuery($url: URL!) {
    viewer {
      username
    }
    actorByUrl(url: $url) {
      ...authorizeInteractionPage_actor
    }
  }
`;

const loadByHandleQuery = routePreloadedQuery(
  (handle: string) =>
    loadQuery<authorizeInteractionPageByHandleQuery>(
      useRelayEnvironment()(),
      authorizeInteractionPageByHandleQuery,
      { handle },
    ),
  "loadAuthorizeInteractionPageByHandleQuery",
);

const loadByUrlQuery = routePreloadedQuery(
  (url: string) =>
    loadQuery<authorizeInteractionPageByUrlQuery>(
      useRelayEnvironment()(),
      authorizeInteractionPageByUrlQuery,
      { url },
    ),
  "loadAuthorizeInteractionPageByUrlQuery",
);

export default function AuthorizeInteractionPage() {
  const { t } = useLingui();
  const [searchParams] = useSearchParams();
  const lookup = () => {
    const raw = searchParams.uri as string | undefined;
    return raw ? classify(raw) : undefined;
  };

  return (
    <div class="p-4">
      <Title>{t`Follow from your account`}</Title>
      <div class="max-w-2xl mx-auto">
        <Show
          keyed
          when={lookup()}
          fallback={
            <div class="rounded-lg border p-6" role="alert">
              <p class="text-destructive">{t`No user URI provided.`}</p>
            </div>
          }
        >
          {(validLookup) =>
            validLookup.kind === "handle"
              ? <ByHandle handle={validLookup.value} />
              : <ByUrl url={validLookup.value} />}
        </Show>
      </div>
    </div>
  );
}

function ByHandle(props: { handle: string }) {
  const data = createPreloadedQuery<authorizeInteractionPageByHandleQuery>(
    authorizeInteractionPageByHandleQuery,
    () => loadByHandleQuery(props.handle),
  );
  return (
    <Show keyed when={data()}>
      {(result) => (
        <Frame
          uri={props.handle}
          viewerUsername={result.viewer?.username}
          $actor={result.actorByHandle ?? null}
        />
      )}
    </Show>
  );
}

function ByUrl(props: { url: string }) {
  const data = createPreloadedQuery<authorizeInteractionPageByUrlQuery>(
    authorizeInteractionPageByUrlQuery,
    () => loadByUrlQuery(props.url),
  );
  return (
    <Show keyed when={data()}>
      {(result) => (
        <Frame
          uri={props.url}
          viewerUsername={result.viewer?.username}
          $actor={result.actorByUrl ?? null}
        />
      )}
    </Show>
  );
}

interface FrameProps {
  uri: string;
  viewerUsername: string | undefined;
  $actor: authorizeInteractionPage_actor$key | null;
}

function Frame(props: FrameProps) {
  const { t } = useLingui();
  const navigate = useNavigate();

  createEffect(() => {
    if (props.viewerUsername) return;
    const currentUrl = `/authorize_interaction?uri=${
      encodeURIComponent(props.uri)
    }`;
    navigate(`/sign?next=${encodeURIComponent(currentUrl)}`, { replace: true });
  });

  return (
    <Show when={props.viewerUsername}>
      <div class="rounded-lg border p-6 space-y-4">
        <h1 class="text-lg font-semibold">{t`Follow from your account`}</h1>
        <Show
          keyed
          when={props.$actor}
          fallback={
            <div class="rounded-md border p-4">
              <code class="text-sm break-all">{props.uri}</code>
            </div>
          }
        >
          {(actorRef) => (
            <ActorPanel
              $actor={actorRef}
              viewerUsername={props.viewerUsername!}
            />
          )}
        </Show>
      </div>
    </Show>
  );
}

function ActorPanel(
  props: {
    $actor: authorizeInteractionPage_actor$key;
    viewerUsername: string;
  },
) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const actor = createFragment(
    graphql`
      fragment authorizeInteractionPage_actor on Actor {
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
    `,
    () => props.$actor,
  );

  return (
    <Show keyed when={actor()}>
      {(a) => (
        <>
          <p class="text-sm text-muted-foreground">
            {t`You are about to follow ${a.name ?? a.handle}.`}
          </p>

          <div class="rounded-md border p-4">
            <div class="flex items-start gap-3">
              <Avatar class="size-12 flex-shrink-0">
                <AvatarImage src={a.avatarUrl} />
                <AvatarFallback>{a.avatarInitials}</AvatarFallback>
              </Avatar>
              <div class="flex-1 min-w-0">
                <Show keyed when={a.name}>
                  {(name) => (
                    <h2
                      class="font-semibold truncate"
                      aria-label={a.rawName ?? a.username}
                    >
                      {name}
                    </h2>
                  )}
                </Show>
                <p class="text-sm text-muted-foreground truncate">
                  {a.handle}
                </p>
                <Show keyed when={a.instance}>
                  {(instance) => (
                    <p class="text-xs text-muted-foreground mt-1">
                      {instance.host}
                    </p>
                  )}
                </Show>
              </div>
            </div>
          </div>

          <div class="flex items-center justify-between">
            <p class="text-sm text-muted-foreground">
              {t`Signed in as`} <strong>@{props.viewerUsername}</strong>
            </p>
            <div class="flex gap-3 items-center justify-between">
              <Button
                variant="outline"
                as="a"
                href={a.url ?? a.iri}
              >
                {t`Cancel`}
              </Button>
              <FollowButton
                $actor={a}
                onFollowed={() => navigate(`/${a.handle}`, { replace: true })}
              />
            </div>
          </div>
        </>
      )}
    </Show>
  );
}
