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
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import {
  PostVisibility,
  PostVisibilitySelect,
} from "~/components/PostVisibilitySelect.tsx";
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
import { Checkbox } from "~/components/ui/checkbox.tsx";
import { Label } from "~/components/ui/label.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { preferencesMutation } from "./__generated__/preferencesMutation.graphql.ts";
import type { preferencesPageQuery } from "./__generated__/preferencesPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload(args) {
    void loadPreferencesPageQuery(args.params.handle!);
  },
} satisfies RouteDefinition;

const preferencesPageQuery = graphql`
  query preferencesPageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      preferAiSummary
      defaultNoteVisibility
      defaultShareVisibility
      ...SettingsTabs_account
      actor {
        ...ProfilePageBreadcrumb_actor
      }
    }
  }
`;

const loadPreferencesPageQuery = query(
  (handle: string) =>
    loadQuery<preferencesPageQuery>(
      useRelayEnvironment()(),
      preferencesPageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadPreferencesPageQuery",
);

const preferencesMutation = graphql`
  mutation preferencesMutation(
    $id: ID!,
    $preferAiSummary: Boolean!,
    $defaultNoteVisibility: PostVisibility!,
    $defaultShareVisibility: PostVisibility!
  ) {
    updateAccount(input: {
      id: $id,
      preferAiSummary: $preferAiSummary,
      defaultNoteVisibility: $defaultNoteVisibility,
      defaultShareVisibility: $defaultShareVisibility,
    }) {
      account {
        id
        preferAiSummary
        defaultNoteVisibility
        defaultShareVisibility
        ...SettingsTabs_account
      }
    }
  }
`;

export default function PreferencesPage() {
  const params = useParams();
  const location = useLocation();
  const { t } = useLingui();
  let preferAiSummaryDiv: HTMLDivElement | undefined;
  const data = createPreloadedQuery<preferencesPageQuery>(
    preferencesPageQuery,
    () => loadPreferencesPageQuery(params.handle!),
  );
  const [noteVisibility, setNoteVisibility] = createSignal<
    PostVisibility | undefined
  >(undefined);
  const [shareVisibility, setShareVisibility] = createSignal<
    PostVisibility | undefined
  >(undefined);
  const [save] = createMutation<preferencesMutation>(preferencesMutation);
  const [saving, setSaving] = createSignal(false);
  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const account = data()?.accountByUsername;
    const id = account?.id;
    if (!id || preferAiSummaryDiv == null) return;
    setSaving(true);
    save({
      variables: {
        id,
        preferAiSummary: preferAiSummaryDiv.querySelector("input")?.checked ??
          false,
        defaultNoteVisibility: noteVisibility() ??
          account.defaultNoteVisibility,
        defaultShareVisibility: shareVisibility() ??
          account.defaultShareVisibility,
      },
      onCompleted() {
        setSaving(false);
        showToast({
          title: t`Successfully saved preferences`,
          description: t`Your preferences have been updated successfully.`,
        });
      },
      onError(error) {
        console.error(error);
        setSaving(false);
        showToast({
          title: t`Failed to save preferences`,
          description:
            t`An error occurred while saving your preferences. Please try again, or contact support if the problem persists.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }
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
                <Title>{t`Preferences`}</Title>
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
                      {t`Preferences`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div class="p-4">
                  <div class="mx-auto max-w-prose">
                    <SettingsTabs
                      selected="preferences"
                      $account={account()}
                    />
                    <Card class="mt-4">
                      <CardHeader>
                        <CardTitle>{t`Preferences`}</CardTitle>
                        <CardDescription>
                          {t`Set your personal preferences.`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <form on:submit={onSubmit} class="flex flex-col gap-4">
                          <div class="flex items-start space-x-2">
                            <Checkbox
                              id="prefer-ai-summary"
                              ref={preferAiSummaryDiv}
                              defaultChecked={account().preferAiSummary}
                            />
                            <div class="grid gap-1.5 leading-none">
                              <Label for="prefer-ai-summary">
                                {t`Prefer AI-generated summary`}
                              </Label>
                              <p class="text-sm text-muted-foreground">
                                {t`If enabled, the AI will generate a summary of the article for you. Otherwise, the first few lines of the article will be used as the summary.`}
                              </p>
                            </div>
                          </div>
                          <div class="flex flex-row gap-4">
                            <div class="grow flex flex-col gap-1.5">
                              <Label>{t`Default note privacy`}</Label>
                              <PostVisibilitySelect
                                value={noteVisibility() ??
                                  account()
                                    .defaultNoteVisibility as PostVisibility}
                                onChange={setNoteVisibility}
                              />
                              <p class="text-sm text-muted-foreground">
                                {t`The default privacy setting for your notes.`}
                              </p>
                            </div>
                            <div class="grow flex flex-col gap-1.5">
                              <Label>{t`Default share privacy`}</Label>
                              <PostVisibilitySelect
                                value={shareVisibility() ??
                                  account()
                                    .defaultShareVisibility as PostVisibility}
                                onChange={setShareVisibility}
                              />
                              <p class="text-sm text-muted-foreground">
                                {t`The default privacy setting for your shares.`}
                              </p>
                            </div>
                          </div>
                          <Button
                            type="submit"
                            class="cursor-pointer"
                            disabled={saving()}
                          >
                            {saving() ? t`Saving…` : t`Save`}
                          </Button>
                        </form>
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
