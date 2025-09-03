import {
  Navigate,
  query,
  type RouteDefinition,
  useLocation,
  useParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import {
  createFragment,
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { LanguageList } from "~/components/LanguageList.tsx";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Title } from "~/components/Title.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { showToast } from "../../../../components/ui/toast.tsx";
import type { languageMutation } from "./__generated__/languageMutation.graphql.ts";
import type { languagePageQuery } from "./__generated__/languagePageQuery.graphql.ts";
import type { languagePreferredLanguagesForm_locales$key } from "./__generated__/languagePreferredLanguagesForm_locales.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload(args) {
    void loadLanguagePageQuery(args.params.handle);
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
      actor {
        ...ProfilePageBreadcrumb_actor
      }
    }
  }
`;

const loadLanguagePageQuery = query(
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
  const location = useLocation();
  const { t } = useLingui();
  const data = createPreloadedQuery<languagePageQuery>(
    languagePageQuery,
    () => loadLanguagePageQuery(params.handle),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show
            when={data().viewer}
            fallback={
              <Navigate
                href={`/sign?next=${encodeURIComponent(location.pathname)}`}
              />
            }
          >
            {(viewer) => (
              <Show when={data().accountByUsername}>
                {(account) => (
                  <Show when={viewer().id !== account().id}>
                    <Navigate href="/" />
                  </Show>
                )}
              </Show>
            )}
          </Show>
          <Show when={data().accountByUsername}>
            {(account) => (
              <>
                <Title>{t`Language settings`}</Title>
                <ProfilePageBreadcrumb $actor={account().actor}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink href={`/@${account().username}/settings`}>
                      {t`Settings`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink current>
                      {t`Language settings`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div class="p-4">
                  <div class="mx-auto max-w-prose">
                    <SettingsTabs
                      selected="language"
                      $account={account()}
                    />
                    <Card class="mt-4">
                      <CardHeader>
                        <CardTitle>{t`Preferred languages`}</CardTitle>
                        <CardDescription>
                          {t`Select your preferred languages in order of preference. This will help tailor content to your preferences.`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <PreferredLanguagesForm $locales={account()} />
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </>
            )}
          </Show>
        </>
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
    (account()?.locales ?? []).map((l) => new Intl.Locale(l)) as [
      Intl.Locale,
      ...readonly Intl.Locale[],
    ],
  );
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
    <form on:submit={onSubmit}>
      <LanguageList
        locales={locales()}
        onChange={setLocales}
      />
      <Button type="submit" class="w-full cursor-pointer" disabled={saving()}>
        {saving() ? t`Saving…` : t`Save`}
      </Button>
    </form>
  );
}
