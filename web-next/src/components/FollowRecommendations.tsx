import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  Suspense,
} from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { cn } from "~/lib/utils.ts";
import { createStablePreloadedQuery } from "~/lib/relayPreload.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { FollowRecommendationsQuery } from "./__generated__/FollowRecommendationsQuery.graphql.ts";
import { FollowButton } from "./FollowButton.tsx";

const STORAGE_KEY_PREFIX = "followRecommendationsDismissed";
const BATCH_SIZE = 50;
const MAX_VISIBLE = 5;

function getStorageKey(username: string): string {
  return `${STORAGE_KEY_PREFIX}:${username}`;
}

const followRecommendationsQuery = graphql`
  query FollowRecommendationsQuery($limit: Int, $locale: Locale) {
    viewer {
      actor {
        followees(first: 0) {
          totalCount
        }
      }
      postCount
    }
    recommendedActors(limit: $limit, locale: $locale) {
      id
      handle
      username
      name
      rawName
      avatarUrl
      local
      ...FollowButton_actor
    }
  }
`;

function skipIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="size-4"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function FollowRecommendationsInner(props: { storageKey: string }) {
  const { t, i18n } = useLingui();
  const env = useRelayEnvironment();
  const [hiddenActorIds, setHiddenActorIds] = createSignal(new Set<string>());
  const [dismissed, setDismissed] = createSignal(false);

  const data = createStablePreloadedQuery<FollowRecommendationsQuery>(
    followRecommendationsQuery,
    () =>
      loadQuery<FollowRecommendationsQuery>(
        env(),
        followRecommendationsQuery,
        { limit: BATCH_SIZE, locale: i18n.locale.toString() },
      ),
  );

  const handleDismiss = () => {
    try {
      localStorage.setItem(props.storageKey, "1");
    } catch {
      // storage unavailable, ignore
    }
    setDismissed(true);
  };

  const hideActor = (id: string) => {
    setHiddenActorIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const visibleActors = createMemo(() => {
    const d = data();
    if (!d || dismissed() || !d.viewer) return null;

    const followeesCount = d.viewer.actor.followees.totalCount;
    const postCount = d.viewer.postCount ?? 0;

    // Show when following <= 5, OR (following <= 10 AND posts <= 10)
    if (
      followeesCount > 10 ||
      (followeesCount > 5 && postCount > 10)
    ) {
      return null;
    }

    const allActors = d.recommendedActors;
    if (allActors.length === 0) return null;

    const hidden = hiddenActorIds();
    const filtered = allActors
      .filter((a) => !hidden.has(a.id))
      .slice(0, MAX_VISIBLE);
    if (filtered.length === 0) return null;

    return filtered;
  });

  return (
    <Show when={visibleActors()} keyed>
      {(actors) => (
        <div class="overflow-hidden border bg-card md:rounded-lg md:shadow-sm">
          <div class="flex items-center justify-between border-b px-4 py-3">
            <h2 class="text-sm font-semibold">
              {t`People you might want to follow`}
            </h2>
            <button
              type="button"
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={handleDismiss}
              aria-label={t`Dismiss`}
            >
              {skipIcon()}
            </button>
          </div>
          <For each={actors}>
            {(actor) => {
              const profilePath = actor.local
                ? "/@" + actor.username
                : "/" + actor.handle;

              return (
                <div
                  class={cn(
                    "flex items-center gap-3 px-4 py-3 border-b last:border-none",
                    "hover:bg-muted/30 transition-colors",
                  )}
                >
                  <A
                    href={profilePath}
                    class="size-10 shrink-0 overflow-hidden rounded-full"
                  >
                    <img
                      src={actor.avatarUrl}
                      alt={actor.rawName ?? actor.username}
                      class="size-full object-cover"
                      loading="lazy"
                    />
                  </A>
                  <A
                    href={profilePath}
                    class="min-w-0 flex-1 text-sm no-underline"
                  >
                    <div class="truncate font-medium text-foreground">
                      {actor.name != null
                        ? (
                          <span
                            innerHTML={actor.name}
                            class="[&_.Mention\_actorName]:font-normal [&_.Mention\_actorName]:text-muted-foreground/50"
                          />
                        )
                        : actor.username}
                    </div>
                    <div class="truncate text-muted-foreground">
                      {actor.handle}
                    </div>
                  </A>
                  <FollowButton
                    $actor={actor}
                    onFollowed={() => hideActor(actor.id)}
                  />
                  <button
                    type="button"
                    class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => hideActor(actor.id)}
                    aria-label={t`Skip`}
                  >
                    {skipIcon()}
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      )}
    </Show>
  );
}

function Skeleton() {
  return (
    <div class="overflow-hidden border bg-card md:rounded-lg md:shadow-sm">
      <div class="flex items-center justify-between border-b px-4 py-3">
        <div class="h-4 w-48 animate-pulse rounded bg-muted" />
      </div>
      {[0, 1, 2].map((_i) => (
        <div class="flex items-center gap-3 border-b px-4 py-3 last:border-none">
          <div class="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
          <div class="flex-1 space-y-1.5">
            <div class="h-3.5 w-28 animate-pulse rounded bg-muted" />
            <div class="h-3 w-20 animate-pulse rounded bg-muted" />
          </div>
          <div class="h-8 w-16 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

export function FollowRecommendations() {
  const viewer = useViewer();
  const [dismissalLoaded, setDismissalLoaded] = createSignal(false);
  const [dismissed, setDismissed] = createSignal(false);

  createEffect(() => {
    if (!viewer.isLoaded() || !viewer.isAuthenticated()) return;
    const username = viewer.username();
    if (username == null) return;
    let isDismissed = false;
    try {
      isDismissed = localStorage.getItem(getStorageKey(username)) === "1";
    } catch {
      // storage unavailable, ignore
    }
    setDismissed(isDismissed);
    setDismissalLoaded(true);
  });

  return (
    <Show
      when={dismissalLoaded() &&
        viewer.isLoaded() &&
        viewer.isAuthenticated() &&
        !dismissed()}
    >
      <Suspense fallback={<Skeleton />}>
        <FollowRecommendationsInner
          storageKey={getStorageKey(viewer.username()!)}
        />
      </Suspense>
    </Show>
  );
}
