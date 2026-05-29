import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import {
  createFragment,
  createMutation,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { LanguageList } from "~/components/LanguageList.tsx";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { SettingsCardPage } from "~/components/SettingsCardPage.tsx";
import { SettingsOwnerGuard } from "~/components/SettingsOwnerGuard.tsx";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { languageMutation } from "./__generated__/languageMutation.graphql.ts";
import type { languagePageQuery } from "./__generated__/languagePageQuery.graphql.ts";
import type { languagePreferredLanguagesForm_locales$key } from "./__generated__/languagePreferredLanguagesForm_locales.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

const languagePageQuery = graphql`
  query languagePageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      ...SettingsTabs_account
      ...languagePreferredLanguagesForm_locales
    }
  }
`;

const loadLanguagePageQuery = routePreloadedQuery(
  (handle: string) =>
    loadQuery<languagePageQuery>(
      useRelayEnvironment()(),
      languagePageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadLanguagePageQuery",
);

export default function LanguagePage() {
  const params = useParams();
  const { t } = useLingui();
  const data = createStablePreloadedQuery<languagePageQuery>(
    languagePageQuery,
    () => loadLanguagePageQuery(params.handle!),
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <SettingsOwnerGuard
          accountId={data.accountByUsername?.id}
          viewerId={data.viewer?.id}
        >
          {
            /* `keyed` avoids a "Stale read from <Show>" race when solid-relay
             publishes a fragment snapshot inside `batch()` that flips
             `accountByUsername` to falsy in the same tick as a downstream
             reactive read. Reconcile keeps the account's identity stable
             (`key: "__id"`), so `keyed` only re-mounts on navigation to
             a different account. */
          }
          <Show keyed when={data.accountByUsername}>
            {(account) => (
              <SettingsCardPage
                selected="language"
                title={t`Language settings`}
                cardTitle={t`Preferred languages`}
                description={t`Select your preferred languages in order of preference. This will help tailor content to your preferences.`}
                $account={account}
              >
                <PreferredLanguagesForm $locales={account} />
              </SettingsCardPage>
            )}
          </Show>
        </SettingsOwnerGuard>
      )}
    </Show>
  );
}

const languageMutation = graphql`
  mutation languageMutation($id: ID!, $locales: [Locale!]!) {
    updateAccount(input: { id: $id, locales: $locales }) {
      account {
        ...languagePreferredLanguagesForm_locales
      }
    }
  }
`;

interface PreferredLanguagesFormProps {
  readonly $locales: languagePreferredLanguagesForm_locales$key;
}

function PreferredLanguagesForm(props: PreferredLanguagesFormProps) {
  const { t } = useLingui();
  const account = createFragment(
    graphql`
      fragment languagePreferredLanguagesForm_locales on Account {
        id
        locales
      }
    `,
    () => props.$locales,
  );
  const [locales, setLocales] = createSignal<
    readonly [Intl.Locale, ...readonly Intl.Locale[]]
  >(
    (account()?.locales ?? navigator.languages).map((l) =>
      new Intl.Locale(l)
    ) as [
      Intl.Locale,
      ...readonly Intl.Locale[],
    ],
  );
  const [localeToAdd, setLocaleToAdd] = createSignal<Intl.Locale>();
  const [save] = createMutation<languageMutation>(languageMutation);
  const [saving, setSaving] = createSignal(false);

  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const a = account();
    if (a == null) return;
    const oldLocale = a.locales?.[0];
    setSaving(true);
    save({
      variables: { id: a.id, locales: locales().map((l) => l.baseName) },
      onCompleted() {
        setSaving(false);
        showToast({
          title: t`Successfully saved language preferences`,
          description: t`Your preferred languages have been updated.`,
        });
        if (locales()[0].baseName !== oldLocale) {
          // FIXME: Ideally we would just update the i18n context, but I can't
          // figure out how to do that at the moment. So we'll just reload the
          // page for now.
          window.location.reload();
        }
      },
      onError(error) {
        console.error(error);
        showToast({
          title: t`Failed to save language preferences`,
          description:
            t`An error occurred while saving your preferred languages. Please try again, or contact support if the problem persists.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
        setSaving(false);
      },
    });
  }

  return (
    <form on:submit={onSubmit} class="flex flex-col gap-4">
      <LanguageList
        locales={locales()}
        onChange={setLocales}
      />
      <div class="flex flex-row gap-4">
        <LanguageSelect
          class="w-full"
          value={localeToAdd() == null ? null : localeToAdd()}
          onChange={setLocaleToAdd}
          exclude={locales()}
        />
        <div class="shrink">
          <Button
            type="button"
            variant="default"
            class="w-full cursor-pointer"
            disabled={localeToAdd() == null}
            on:click={() => {
              setLocales((locales) => [...locales, localeToAdd()!]);
              setLocaleToAdd(undefined);
            }}
          >
            {t`Add`}
          </Button>
        </div>
      </div>
      <Button type="submit" class="w-full cursor-pointer" disabled={saving()}>
        {saving() ? t`Saving…` : t`Save`}
      </Button>
    </form>
  );
}
