import { toaster } from "@kobalte/core";
import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Title } from "~/components/Title.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Checkbox } from "~/components/ui/checkbox.tsx";
import { Label } from "~/components/ui/label.tsx";
import {
  Toast,
  ToastContent,
  ToastDescription,
  ToastList,
  ToastRegion,
  ToastTitle,
} from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { preferencesMutation } from "./__generated__/preferencesMutation.graphql.ts";
import type { preferencesPageQuery } from "./__generated__/preferencesPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload(args) {
    void loadPreferencesPageQuery(args.params.handle);
  },
} satisfies RouteDefinition;

const preferencesPageQuery = graphql`
  query preferencesPageQuery($username: String!) {
    accountByUsername(username: $username) {
      id
      username
      preferAiSummary
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
  mutation preferencesMutation($id: ID!, $preferAiSummary: Boolean!) {
    updateAccount(input: {
      id: $id,
      preferAiSummary: $preferAiSummary
    }) {
      account {
        id
        preferAiSummary
        ...SettingsTabs_account
      }
    }
  }
`;

export default function PreferencesPage() {
  const params = useParams();
  const { t } = useLingui();
  let preferAiSummaryDiv: HTMLDivElement | undefined;
  const data = createPreloadedQuery<preferencesPageQuery>(
    preferencesPageQuery,
    () => loadPreferencesPageQuery(params.handle),
  );
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
      },
      onCompleted() {
        setSaving(false);
        toaster.show((props) => (
          <Toast toastId={props.toastId} variant="default">
            <ToastContent>
              <ToastTitle>{t`Successfully saved preferences`}</ToastTitle>
              <ToastDescription>
                {t`Your preferences have been updated successfully.`}
              </ToastDescription>
            </ToastContent>
          </Toast>
        ));
      },
      onError() {
        toaster.show((props) => (
          <Toast toastId={props.toastId} variant="destructive">
            <ToastContent>
              <ToastTitle>{t`Failed to save preferences`}</ToastTitle>
              <ToastDescription>
                {t`An error occurred while saving your preferences. Please try again, or contact support if the problem persists.`}
              </ToastDescription>
            </ToastContent>
          </Toast>
        ));
        setSaving(false);
      },
    });
  }
  return (
    <Show when={data()}>
      {(data) => (
        <Show when={data().accountByUsername}>
          {(account) => (
            <>
              <Title>{t`Preferences`}</Title>
              <ToastRegion>
                <ToastList />
              </ToastRegion>
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
                  <form on:submit={onSubmit} class="flex flex-col gap-4 mt-4">
                    <div class="flex items-start space-x-2">
                      <Checkbox
                        id="prefer-ai-summary"
                        ref={preferAiSummaryDiv}
                        defaultChecked={account().preferAiSummary}
                      />
                      <div class="grid gap-1.5 leading-none">
                        <Label for="prefer-ai-summary-input">
                          {t`Prefer AI-generated summary`}
                        </Label>
                        <p class="text-sm text-muted-foreground">
                          {t`If enabled, the AI will generate a summary of the article for you. Otherwise, the first few lines of the article will be used as the summary.`}
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
                </div>
              </div>
            </>
          )}
        </Show>
      )}
    </Show>
  );
}
