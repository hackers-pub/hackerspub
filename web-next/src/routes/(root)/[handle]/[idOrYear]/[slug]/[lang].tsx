import { normalizeLocale } from "@hackerspub/models/i18n";
import { Navigate, type RouteDefinition, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { HttpStatusCode } from "@solidjs/start";
import {
  type Disposable,
  fetchQuery,
  graphql,
  type Subscription,
} from "relay-runtime";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { LangPageQuery } from "./__generated__/LangPageQuery.graphql.ts";
import type { LangPage_requestArticleTranslation_Mutation } from "./__generated__/LangPage_requestArticleTranslation_Mutation.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import {
  ArticleBody,
  ArticleMetaHead,
  ArticleTranslationFailure,
  ArticleTranslationPlaceholder,
} from "./index.tsx";

// Matches the staleness window inside `startArticleContentTranslation`
// (`models/article.ts`).  After 30 minutes of no `updated` change on a
// `beingTranslated: true` row, the model's retry path is willing to
// re-queue the translation, so the route should re-fire its mutation
// instead of polling forever.
const TRANSLATION_STALE_MS = 30 * 60 * 1000;

// Two BCP 47 tags refer to the same translation output when their
// maximized forms agree on both the `language` and `script` subtags.
// The same `requestArticleTranslation` rule lives on the backend
// (`graphql/post.ts`); the route uses it to distinguish "user asked
// for a regional variant we already have content for, so redirect to
// the canonical URL" from "user asked for a different script (e.g.,
// `zh-TW` against a `zh-CN` original), which is a meaningfully
// different translation we should queue."  Either tag may be null or
// malformed (the GraphQL `Article.language` is nullable, and a
// content row's `language` could in principle be a tag the runtime
// can't parse); in those cases there's nothing to compare so we
// conservatively report "no match."
function matchesLanguageScript(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  try {
    const aMax = new Intl.Locale(a).maximize();
    const bMax = new Intl.Locale(b).maximize();
    return aMax.language === bMax.language && aMax.script === bMax.script;
  } catch {
    return false;
  }
}

export const route = {
  matchFilters: {
    handle: /^@/,
    lang: /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]+)*$/,
  },
} satisfies RouteDefinition;

const LangPageQueryDef = graphql`
  query LangPageQuery(
    $handle: String!
    $idOrYear: String!
    $slug: String!
    $language: Locale!
  ) {
    articleByYearAndSlug(
      handle: $handle
      idOrYear: $idOrYear
      slug: $slug
    ) {
      id
      language
      allowLlmTranslation
      publishedYear
      slug
      actor {
        username
      }
      contents(language: $language, includeBeingTranslated: true) {
        language
        originalLanguage
        beingTranslated
        updated
      }
      ...Slug_head
        @arguments(language: $language, includeBeingTranslated: true)
      ...Slug_body
        @arguments(language: $language, includeBeingTranslated: true)
    }
    viewer {
      id
      locales
      ...Slug_viewer
    }
  }
`;

const requestArticleTranslationMutation = graphql`
  mutation LangPage_requestArticleTranslation_Mutation(
    $input: RequestArticleTranslationInput!
    $language: Locale!
  ) {
    requestArticleTranslation(input: $input) {
      __typename
      ... on RequestArticleTranslationPayload {
        article {
          id
          contents(language: $language, includeBeingTranslated: true) {
            language
            beingTranslated
          }
          ...Slug_head
            @arguments(language: $language, includeBeingTranslated: true)
          ...Slug_body
            @arguments(language: $language, includeBeingTranslated: true)
        }
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on LlmTranslationNotAllowedError {
        reason
      }
    }
  }
`;

const loadLangPageQuery = routePreloadedQuery(
  (handle: string, idOrYear: string, slug: string, language: string) =>
    loadQuery<LangPageQuery>(
      useRelayEnvironment()(),
      LangPageQueryDef,
      { handle, idOrYear, slug, language },
    ),
  "loadArticleLangPageQuery",
);

export default function ArticleLangPage() {
  const params = useParams();

  return (
    <Show
      keyed
      when={normalizeLocale(params.lang!)}
      fallback={<HttpStatusCode code={404} />}
    >
      {(language) => (
        <ArticleLangPageContent
          handle={decodeRouteParam(params.handle!)}
          idOrYear={params.idOrYear!}
          slug={decodeRouteParam(params.slug!)}
          language={language}
        />
      )}
    </Show>
  );
}

interface ArticleLangPageContentProps {
  handle: string;
  idOrYear: string;
  slug: string;
  language: string;
}

function ArticleLangPageContent(props: ArticleLangPageContentProps) {
  const { t } = useLingui();
  const env = useRelayEnvironment();
  const [requestTranslation] = createMutation<
    LangPage_requestArticleTranslation_Mutation
  >(requestArticleTranslationMutation);
  const [requestFailed, setRequestFailed] = createSignal(false);
  let pendingRequest: Disposable | null = null;
  onCleanup(() => pendingRequest?.dispose());

  const data = createStablePreloadedQuery<LangPageQuery>(
    LangPageQueryDef,
    () =>
      loadLangPageQuery(
        props.handle,
        props.idOrYear,
        props.slug,
        props.language,
      ),
  );

  const article = createMemo(() => data()?.articleByYearAndSlug ?? null);
  const content = createMemo(() => article()?.contents[0] ?? null);
  const viewer = createMemo(() => data()?.viewer ?? null);
  const canRequestTranslation = createMemo(() => {
    const a = article();
    return viewer() != null && a != null && a.allowLlmTranslation &&
      !matchesLanguageScript(a.language, props.language);
  });
  // Mirrors the `30 * 60 * 1000` staleness window inside
  // `startArticleContentTranslation`: if the placeholder row hasn't
  // updated in 30 minutes the background translation worker has
  // probably died, and the model layer's retry path will accept a
  // fresh `requestArticleTranslation` call to re-queue it.
  // `Date.parse` returns `NaN` if the GraphQL `DateTime` scalar ever
  // hands us back something that isn't a valid ISO-8601 timestamp;
  // a `NaN` comparison is always false, so we'd silently treat the
  // row as fresh forever and never retry, which is the wrong default
  // for a stuck translation.  Treat unparseable timestamps as
  // `0` (Unix epoch) so the row reads as definitively stale and the
  // retry path gets a chance to recover.
  const isStaleInProgress = createMemo(() => {
    const c = content();
    if (c == null || !c.beingTranslated) return false;
    const updatedMs = Date.parse(c.updated);
    const lastUpdate = Number.isNaN(updatedMs) ? 0 : updatedMs;
    return lastUpdate < Date.now() - TRANSLATION_STALE_MS;
  });
  const shouldAutoRequest = createMemo(() => {
    if (!canRequestTranslation()) return false;
    const c = content();
    if (c == null) return true;
    if (isStaleInProgress()) return true;
    // `Article.contents` negotiates among available locales, so a
    // request for `zh-TW` on a `zh-CN`-only article comes back with
    // the `zh-CN` row.  Don't render that under the wrong-script URL
    // and don't redirect away from what the user asked for; queue a
    // translation in their requested script instead.
    if (!matchesLanguageScript(c.language, props.language)) return true;
    return false;
  });
  // Counter that bumps every time content transitions from existing
  // to null.  The auto-request effect uses it (via `requestKey`) to
  // distinguish "still the same first-time-missing render" from "the
  // background failure-cleanup branch in
  // `startArticleContentTranslation` deleted the placeholder row and
  // we need to re-queue."
  const [missingEpoch, setMissingEpoch] = createSignal(0);
  let prevContentExisted = false;
  createEffect(() => {
    const exists = content() != null;
    if (prevContentExisted && !exists) {
      setMissingEpoch((n) => n + 1);
    }
    prevContentExisted = exists;
  });
  // Counter for explicit user-initiated retries.  Bumping it changes
  // `requestKey()`, which causes the auto-request effect to fire
  // another mutation; we use this so a transient failure (e.g. a
  // brief network drop) doesn't strand the user on a permanent
  // not-found state without a way to recover short of reloading.
  const [retryAttempt, setRetryAttempt] = createSignal(0);
  const handleRetry = () => {
    setRequestFailed(false);
    setRetryAttempt((n) => n + 1);
  };
  // Identity for "this is a fresh reason to fire the mutation."  When
  // it changes, the auto-request effect fires another mutation; when
  // it stays the same (or is null because we don't need to request),
  // it doesn't.  The stale branch includes `content()?.updated` so a
  // second-time-stale row produces a different key from the first
  // stale fire; the missing branch includes `missingEpoch()` so a
  // row that gets deleted, re-queued, then deleted again produces a
  // different key each time; both branches include `retryAttempt()`
  // so a manual retry forces a re-fire even if nothing else has
  // moved.
  const requestKey = createMemo(() => {
    if (!shouldAutoRequest()) return null;
    const c = content();
    const retry = retryAttempt();
    if (c == null) {
      return `missing/${article()?.id}/${props.language}/${missingEpoch()}/${retry}`;
    }
    return `stale/${article()?.id}/${props.language}/${c.updated}/${retry}`;
  });
  const canonicalBase = createMemo(() => {
    const a = article();
    return a == null
      ? null
      : `/@${a.actor.username}/${a.publishedYear}/${a.slug}`;
  });
  const redirectHref = createMemo(() => {
    const c = content();
    const base = canonicalBase();
    if (c == null || base == null) return null;
    // A logged-in viewer who can request translation gets the
    // auto-request branch when the negotiated content is in a
    // different script; don't preempt that with a redirect.  Guests
    // (and viewers on articles where the author disabled LLM
    // translation) still fall through to the redirect below so they
    // at least see the content that does exist.
    if (
      !matchesLanguageScript(c.language, props.language) &&
      canRequestTranslation()
    ) {
      return null;
    }
    if (c.originalLanguage == null) return base;
    if (c.language !== props.language) return `${base}/${c.language}`;
    return null;
  });

  // Auto-request a translation whenever `requestKey()` changes to a
  // non-null value.  Three edges fire it: initial mount with content
  // missing, the in-progress row going stale (>30 min since
  // `updated`), and the row vanishing again after the background
  // translator's failure-cleanup branch deleted it.  `firedKey` keeps
  // a duplicate fire from happening when an unrelated reactive memo
  // re-evaluates the effect with the same key.  The `requestFailed()`
  // gate stops a stuck backend (mutation succeeds but the cleanup
  // branch deletes the placeholder row, which bumps `missingEpoch`
  // and changes `requestKey`) from re-firing the mutation in a tight
  // loop; the user's "Try again" button (`handleRetry`) clears
  // `requestFailed` and bumps `retryAttempt`, so manual recovery
  // still works.
  let firedRequestKey: string | null = null;

  // Solid Router reuses this component across param-only navigations
  // (e.g., `/zh-TW` -> `/ja` on the same article, or `/ja` on a
  // different article), so any local state from the previous URL
  // would otherwise carry over.  `requestKey()` already includes
  // `props.language` and `article()?.id`, so a navigation produces
  // a fresh key, but `requestFailed` and `firedRequestKey` itself
  // stay sticky: a failure on one `/{lang}` would gate auto-request
  // on the next, and a stale `firedRequestKey` matching the new key
  // (after navigating away and back to the same URL) would keep the
  // effect from re-firing.  Reset both, plus the
  // `prevContentExisted` ref the `missingEpoch` effect relies on,
  // whenever any route param changes; cancel any in-flight mutation
  // too because its result no longer applies.
  createEffect(() => {
    props.handle;
    props.idOrYear;
    props.slug;
    props.language;
    pendingRequest?.dispose();
    pendingRequest = null;
    setRequestFailed(false);
    firedRequestKey = null;
    prevContentExisted = false;
  });

  createEffect(() => {
    const key = requestKey();
    if (key == null || key === firedRequestKey || requestFailed()) return;
    firedRequestKey = key;
    pendingRequest?.dispose();
    pendingRequest = requestTranslation({
      variables: {
        input: {
          articleId: article()!.id,
          targetLanguage: props.language,
        },
        language: props.language,
      },
      onCompleted(response) {
        const payload = response.requestArticleTranslation;
        if (payload.__typename !== "RequestArticleTranslationPayload") {
          console.error(
            "Translation request returned an error payload:",
            payload,
          );
          showToast({
            title: t`Translation request failed`,
            variant: "destructive",
          });
          setRequestFailed(true);
          return;
        }
        // Quick-failure case: the server inserted the placeholder
        // and the background `translate(...)` call rejected
        // synchronously, so by the time Pothos serialized
        // `article.contents` the failure-cleanup branch had
        // already deleted the row.  The payload reports success
        // but there's no in-progress row to render or poll, and
        // the polling effect (gated on
        // `content().beingTranslated`) never gets a chance to
        // recover.  Surface this as a retryable failure so the
        // user sees the retry UI instead of an indefinite
        // placeholder.
        if (payload.article.contents.length === 0) {
          console.error(
            "Translation request returned without a queued row:",
            payload,
          );
          showToast({
            title: t`Translation request failed`,
            variant: "destructive",
          });
          setRequestFailed(true);
        }
      },
      onError(error) {
        console.error("Translation request failed:", error);
        showToast({
          title: t`Translation request failed`,
          variant: "destructive",
        });
        setRequestFailed(true);
      },
    });
  });

  // While a translation is in flight, poll for completion every 30
  // seconds.  When `beingTranslated` flips back to false (translation
  // finished) or the component unmounts, the interval is cleared via
  // `onCleanup` registered inside this effect's tracking scope.
  // `fetchQuery` is used (instead of revalidating the Solid Router
  // cache key) because it forces a network round trip and writes the
  // fresh response into the Relay store, which `createStablePreloadedQuery`
  // observes; revalidating the router cache alone would leave the
  // already-populated Relay store unchanged.
  createEffect(() => {
    if (!content()?.beingTranslated) return;
    // The previous tick's request, if still in flight, is left alone:
    // Relay treats `unsubscribe()` as a cancellation, so cancelling
    // it would mean a slow network/server (poll > 30 s) never gets a
    // chance to write fresh content back to the store.  Skip the new
    // poll instead and let the prior one finish; the next 30 s tick
    // tries again.  Only cancel on `onCleanup` (interval removed,
    // `beingTranslated` flipped, or component unmounted).
    let pending: Subscription | null = null;
    const interval = setInterval(() => {
      if (pending != null) return;
      pending = fetchQuery<LangPageQuery>(env(), LangPageQueryDef, {
        handle: props.handle,
        idOrYear: props.idOrYear,
        slug: props.slug,
        language: props.language,
      }).subscribe({
        complete() {
          pending = null;
        },
        error(error: unknown) {
          // Background polling can hit transient network failures
          // without any UI affordance; surface them in the console
          // so they're discoverable, but don't toast or otherwise
          // interrupt the placeholder.  The next tick will retry on
          // its own.
          pending = null;
          console.error("Translation polling failed:", error);
        },
      });
    }, 30_000);
    onCleanup(() => {
      clearInterval(interval);
      pending?.unsubscribe();
    });
  });

  return (
    <Show when={data() != null}>
      <Switch fallback={<HttpStatusCode code={404} />}>
        <Match when={article() == null}>
          <HttpStatusCode code={404} />
        </Match>
        <Match when={shouldAutoRequest() && requestFailed()}>
          <div class="mt-8 mb-4 px-4 max-w-3xl mx-auto xl:max-w-4xl 2xl:max-w-screen-lg">
            <article class="min-w-0">
              <ArticleTranslationFailure
                targetLanguage={props.language}
                onRetry={handleRetry}
              />
            </article>
          </div>
        </Match>
        <Match when={shouldAutoRequest()}>
          <div class="mt-8 mb-4 px-4 max-w-3xl mx-auto xl:max-w-4xl 2xl:max-w-screen-lg">
            <article class="min-w-0">
              <ArticleTranslationPlaceholder
                targetLanguage={props.language}
              />
            </article>
          </div>
        </Match>
        <Match when={content() == null}>
          <HttpStatusCode code={404} />
        </Match>
        <Match when={isStaleInProgress() && !canRequestTranslation()}>
          {
            /*
             * The placeholder row's `updated` is older than the
             * staleness window and we can't auto-recover (guest, or
             * the article disabled LLM translation after the row was
             * queued).  Treat it as not-found rather than rendering
             * the indefinite "translating" placeholder; otherwise the
             * visitor sees a perpetual spinner with no way for us to
             * recover.  A logged-in viewer with translation rights
             * can still re-trigger the queue from the bare slug page.
             */
          }
          <HttpStatusCode code={404} />
        </Match>
        <Match when={redirectHref() != null}>
          <Navigate href={redirectHref()!} />
        </Match>
        <Match when={article() != null && content() != null}>
          <ArticleMetaHead
            $article={article()!}
            canonicalLanguage={content()!.language}
          />
          <ArticleBody
            $article={article()!}
            $viewer={data()?.viewer ?? undefined}
            viewerLocales={data()?.viewer?.locales}
          />
        </Match>
      </Switch>
    </Show>
  );
}
