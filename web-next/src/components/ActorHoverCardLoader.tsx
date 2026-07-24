import { graphql } from "relay-runtime";
import { ErrorBoundary, type JSX, Show, Suspense } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { createStablePreloadedQuery } from "~/lib/relayPreload.ts";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { ActorHoverCardLoaderByHandleQuery } from "./__generated__/ActorHoverCardLoaderByHandleQuery.graphql.ts";
import type { ActorHoverCardLoaderByUrlQuery } from "./__generated__/ActorHoverCardLoaderByUrlQuery.graphql.ts";
import { ActorPreviewCard } from "./ActorPreviewCard.tsx";
import { ActorPreviewSkeleton } from "./ActorPreviewSkeleton.tsx";

const actorHoverCardLoaderByHandleQuery = graphql`
  query ActorHoverCardLoaderByHandleQuery(
    $handle: String!
    $actingAccountId: ID
  ) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      ...ActorPreviewCard_actor @arguments(actingAccountId: $actingAccountId)
    }
  }
`;

const actorHoverCardLoaderByUrlQuery = graphql`
  query ActorHoverCardLoaderByUrlQuery($url: URL!, $actingAccountId: ID) {
    actorByUrl(url: $url) {
      ...ActorPreviewCard_actor @arguments(actingAccountId: $actingAccountId)
    }
  }
`;

function Unavailable() {
  const { t } = useLingui();
  return (
    <div class="p-4 text-sm text-muted-foreground">
      {t`Could not load profile.`}
    </div>
  );
}

function withFallbacks(loaded: () => JSX.Element) {
  return (
    <ErrorBoundary fallback={() => <Unavailable />}>
      <Suspense fallback={<ActorPreviewSkeleton />}>{loaded()}</Suspense>
    </ErrorBoundary>
  );
}

export interface ActorHoverCardLoaderProps {
  handle: string;
}

// Create the preloaded query inside a child component so it runs *under* the
// `<Suspense>` from `withFallbacks`, not above it. `createStablePreloadedQuery`
// reads `store()` in an eager `createMemo` during the component body; if that
// body executed in `ActorHoverCardLoader` itself, the read would happen before
// the local `<Suspense>` exists and the first-hover suspension would escape to
// the route-level boundary, blanking the whole timeline (the regression of
// commit 19148e2c "Keep profile hover loading local"). Rendering this child as
// `<Suspense>`'s child defers its body until Solid evaluates the children
// getter under the Suspense owner, so the suspension is caught locally.
function ActorHoverCardByHandle(props: ActorHoverCardLoaderProps) {
  const env = useRelayEnvironment();
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const data = createStablePreloadedQuery<ActorHoverCardLoaderByHandleQuery>(
    actorHoverCardLoaderByHandleQuery,
    () =>
      loadQuery(env(), actorHoverCardLoaderByHandleQuery, {
        handle: props.handle,
        actingAccountId: actingAccountId() ?? null,
      }),
  );

  return (
    <Show keyed when={data()} fallback={<ActorPreviewSkeleton />}>
      {(loaded) => (
        <>
          {/*
            `keyed` prevents a "Stale read from <Show>" race: when
            solid-relay's fragment subscription publishes a new snapshot
            inside `batch()`, a non-keyed `<Show>{(actor) => ...}` accessor
            can throw if `actorByHandle` flips to falsy in the same tick
            that an inner reactive computation re-runs. Reconcile keeps the
            actor's identity stable (`key: "__id"`), so `keyed` only
            re-mounts when navigating to a different actor.
          */}
          <Show keyed when={loaded.actorByHandle} fallback={<Unavailable />}>
            {(actor) => <ActorPreviewCard $actor={actor} />}
          </Show>
        </>
      )}
    </Show>
  );
}

export function ActorHoverCardLoader(props: ActorHoverCardLoaderProps) {
  return withFallbacks(() => <ActorHoverCardByHandle handle={props.handle} />);
}

export interface ActorHoverCardLoaderByUrlProps {
  url: string;
}

// See `ActorHoverCardByHandle` for why the query lives in a child component.
function ActorHoverCardByUrl(props: ActorHoverCardLoaderByUrlProps) {
  const env = useRelayEnvironment();
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const data = createStablePreloadedQuery<ActorHoverCardLoaderByUrlQuery>(
    actorHoverCardLoaderByUrlQuery,
    () =>
      loadQuery(env(), actorHoverCardLoaderByUrlQuery, {
        url: props.url,
        actingAccountId: actingAccountId() ?? null,
      }),
  );

  return (
    <Show keyed when={data()} fallback={<ActorPreviewSkeleton />}>
      {(loaded) => (
        <>
          {/*
            `keyed` prevents a "Stale read from <Show>" race: when
            solid-relay's fragment subscription publishes a new snapshot
            inside `batch()`, a non-keyed `<Show>{(actor) => ...}` accessor
            can throw if `actorByUrl` flips to falsy in the same tick that
            an inner reactive computation re-runs. Reconcile keeps the
            actor's identity stable (`key: "__id"`), so `keyed` only
            re-mounts when navigating to a different actor.
          */}
          <Show keyed when={loaded.actorByUrl} fallback={<Unavailable />}>
            {(actor) => <ActorPreviewCard $actor={actor} />}
          </Show>
        </>
      )}
    </Show>
  );
}

export function ActorHoverCardLoaderByUrl(
  props: ActorHoverCardLoaderByUrlProps,
) {
  return withFallbacks(() => <ActorHoverCardByUrl url={props.url} />);
}
