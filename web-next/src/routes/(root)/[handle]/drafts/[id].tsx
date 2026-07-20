import { A, useNavigate, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { ArticleComposer } from "~/components/article-composer/index.ts";
import { Title } from "~/components/Title.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { IdQuery } from "./__generated__/IdQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

const EditDraftViewerQuery = graphql`
  query IdQuery {
    viewer {
      id
      username
    }
  }
`;

const loadEditDraftViewerQuery = routePreloadedQuery(
  () =>
    loadQuery<IdQuery>(
      useRelayEnvironment()(),
      EditDraftViewerQuery,
      {},
    ),
  "loadEditDraftViewerQuery",
);

interface ComposerState {
  readonly draftUuid?: string;
}

export default function ArticleDraftPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const params = useParams();
  const [composerState, setComposerState] = createSignal<ComposerState>({
    draftUuid: params.id === "new" ? undefined : params.id,
  });
  const [savedDraftId, setSavedDraftId] = createSignal<string>();
  // Replacing `/new` with the first saved draft URL must not remount the
  // composer: the server may have normalized whitespace that is still present
  // in the form. Other route changes should create a fresh composer.
  let savedNavigationUuid: string | undefined;
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const data = createStablePreloadedQuery<IdQuery>(
    EditDraftViewerQuery,
    () => loadEditDraftViewerQuery(),
  );

  createEffect(on(
    () => params.id,
    (draftUuid) => {
      if (draftUuid === savedNavigationUuid) {
        savedNavigationUuid = undefined;
        return;
      }

      savedNavigationUuid = undefined;
      setSavedDraftId(undefined);
      setComposerState({
        draftUuid: draftUuid === "new" ? undefined : draftUuid,
      });
    },
    { defer: true },
  ));

  const handleSaved = (
    source: ComposerState,
    draftId: string,
    draftUuid: string,
  ) => {
    if (!active || composerState() !== source) return;

    savedNavigationUuid = draftUuid;
    setSavedDraftId(draftId);
    navigate(`/${params.handle}/drafts/${draftUuid}`, { replace: true });
  };

  const creatingDraft = () =>
    composerState().draftUuid == null && savedDraftId() == null;

  return (
    <Show
      when={data()?.viewer?.username ===
        decodeRouteParam(params.handle!).substring(1)}
      fallback={
        <WideContainer class="p-6">
          <HttpStatusCode code={403} />
          <Title>{t`Permission denied`}</Title>
          <h1 class="text-2xl font-bold mb-4">{t`Permission denied`}</h1>
          <p class="text-muted-foreground mb-4">
            {data()?.viewer
              ? creatingDraft()
                ? t`You can only create drafts for your own account`
                : t`You can only edit your own drafts`
              : t`Please sign in to access this page`}
          </p>
          <div class="flex gap-2">
            <Button onClick={() => window.history.back()}>
              {t`Go back`}
            </Button>
            <Show keyed when={data()?.viewer?.username}>
              {(username) => (
                <A href={`/@${username}/drafts`}>
                  <Button variant="outline">{t`Go to my drafts`}</Button>
                </A>
              )}
            </Show>
          </div>
        </WideContainer>
      }
    >
      <div class="flex h-[100dvh] flex-col overflow-hidden">
        <Title>{creatingDraft() ? t`New article` : t`Edit draft`}</Title>
        <Show keyed when={composerState()}>
          {(state) => (
            <ArticleComposer
              draftUuid={state.draftUuid}
              onSaved={state.draftUuid == null
                ? (draftId, draftUuid) => handleSaved(state, draftId, draftUuid)
                : undefined}
              viewerId={data()?.viewer?.id}
            />
          )}
        </Show>
      </div>
    </Show>
  );
}
