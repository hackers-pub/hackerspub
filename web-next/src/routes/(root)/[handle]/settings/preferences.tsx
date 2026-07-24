import { type RouteDefinition, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { graphql } from "relay-runtime";
import { createMemo, createSignal, Show } from "solid-js";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import {
  PostVisibility,
  PostVisibilitySelect,
} from "~/components/PostVisibilitySelect.tsx";
import {
  type QuotePolicy,
  QuotePolicySelect,
} from "~/components/QuotePolicySelect.tsx";
import { SettingsContainer } from "~/components/SettingsContainer.tsx";
import { SettingsOwnerGuard } from "~/components/SettingsOwnerGuard.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Title } from "~/components/Title.tsx";
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
import { useLingui } from "~/lib/i18n/macro.ts";
import type { preferencesDigestMutation } from "./__generated__/preferencesDigestMutation.graphql.ts";
import type { preferencesFormQuery } from "./__generated__/preferencesFormQuery.graphql.ts";
import type { preferencesInteractionScopeMutation } from "./__generated__/preferencesInteractionScopeMutation.graphql.ts";
import type { preferencesSummaryMutation } from "./__generated__/preferencesSummaryMutation.graphql.ts";
import type { preferencesPageQuery } from "./__generated__/preferencesPageQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
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
      viewerCanManageSettings
      ...SettingsTabs_account
    }
  }
`;

const preferencesFormQuery = graphql`
  query preferencesFormQuery($username: String!) {
    accountByUsername(username: $username) {
      id
      username
      preferAiSummary
      notificationEmailDigestDaily
      notificationEmailDigestWeekly
      defaultNoteVisibility
      defaultShareVisibility
      defaultQuotePolicy
      ...SettingsTabs_account
    }
  }
`;

const loadPreferencesPageQuery = routePreloadedQuery(
  (handle: string) =>
    loadQuery<preferencesPageQuery>(
      useRelayEnvironment()(),
      preferencesPageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadPreferencesPageQuery",
);

const loadPreferencesFormQuery = routePreloadedQuery(
  (handle: string) =>
    loadQuery<preferencesFormQuery>(
      useRelayEnvironment()(),
      preferencesFormQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadPreferencesFormQuery",
);

const preferencesSummaryMutation = graphql`
  mutation preferencesSummaryMutation($id: ID!, $preferAiSummary: Boolean!) {
    updateAccount(input: { id: $id, preferAiSummary: $preferAiSummary }) {
      account {
        id
        preferAiSummary
        ...SettingsTabs_account
      }
    }
  }
`;

const preferencesInteractionScopeMutation = graphql`
  mutation preferencesInteractionScopeMutation(
    $id: ID!
    $defaultNoteVisibility: PostVisibility!
    $defaultShareVisibility: PostVisibility!
    $defaultQuotePolicy: QuotePolicy!
  ) {
    updateAccount(
      input: {
        id: $id
        defaultNoteVisibility: $defaultNoteVisibility
        defaultShareVisibility: $defaultShareVisibility
        defaultQuotePolicy: $defaultQuotePolicy
      }
    ) {
      account {
        id
        defaultNoteVisibility
        defaultShareVisibility
        defaultQuotePolicy
        ...SettingsTabs_account
      }
    }
  }
`;

const preferencesDigestMutation = graphql`
  mutation preferencesDigestMutation(
    $id: ID!
    $notificationEmailDigestDaily: Boolean!
    $notificationEmailDigestWeekly: Boolean!
  ) {
    updateNotificationEmailDigestSettings(
      input: {
        id: $id
        daily: $notificationEmailDigestDaily
        weekly: $notificationEmailDigestWeekly
      }
    ) {
      account {
        id
        notificationEmailDigestDaily
        notificationEmailDigestWeekly
      }
    }
  }
`;

export default function PreferencesPage() {
  const params = useParams();
  const { t } = useLingui();
  const handle = createMemo(() => decodeRouteParam(params.handle!));
  const data = createStablePreloadedQuery<preferencesPageQuery>(
    preferencesPageQuery,
    () => loadPreferencesPageQuery(handle()),
  );
  return (
    <Show keyed when={data()}>
      {(data) => (
        <SettingsOwnerGuard
          accountId={data.accountByUsername?.id}
          canManageSettings={data.accountByUsername?.viewerCanManageSettings}
          viewerId={data.viewer?.id}
        >
          <Show keyed when={data.accountByUsername}>
            {(account) => (
              <>
                <Title>{t`Preferences`}</Title>
                <SettingsContainer class="p-4">
                  <SettingsTabs selected="preferences" $account={account} />
                  <PreferencesForm handle={handle()} />
                </SettingsContainer>
              </>
            )}
          </Show>
        </SettingsOwnerGuard>
      )}
    </Show>
  );
}

function PreferencesForm(props: { handle: string }) {
  const { t } = useLingui();
  let preferAiSummaryDiv: HTMLDivElement | undefined;
  let dailyDigestDiv: HTMLDivElement | undefined;
  let weeklyDigestDiv: HTMLDivElement | undefined;
  const data = createStablePreloadedQuery<preferencesFormQuery>(
    preferencesFormQuery,
    () => loadPreferencesFormQuery(props.handle),
  );
  const [noteVisibility, setNoteVisibility] = createSignal<
    PostVisibility | undefined
  >(undefined);
  const [shareVisibility, setShareVisibility] = createSignal<
    PostVisibility | undefined
  >(undefined);
  const [quotePolicy, setQuotePolicy] = createSignal<QuotePolicy | undefined>(
    undefined,
  );
  const quotePolicyLocked = createMemo(() => {
    const account = data()?.accountByUsername;
    const vis = noteVisibility() ?? account?.defaultNoteVisibility;
    return vis === "FOLLOWERS" || vis === "DIRECT";
  });
  const [saveSummary] = createMutation<preferencesSummaryMutation>(
    preferencesSummaryMutation,
  );
  const [saveInteractionScope] =
    createMutation<preferencesInteractionScopeMutation>(
      preferencesInteractionScopeMutation,
    );
  const [saveDigest] = createMutation<preferencesDigestMutation>(
    preferencesDigestMutation,
  );
  const [savingSummary, setSavingSummary] = createSignal(false);
  const [savingInteractionScope, setSavingInteractionScope] =
    createSignal(false);
  const [savingDigest, setSavingDigest] = createSignal(false);
  function onSummarySubmit(event: SubmitEvent) {
    event.preventDefault();
    const account = data()?.accountByUsername;
    const id = account?.id;
    if (!id || preferAiSummaryDiv == null) return;
    setSavingSummary(true);
    saveSummary({
      variables: {
        id,
        preferAiSummary:
          preferAiSummaryDiv.querySelector("input")?.checked ?? false,
      },
      onCompleted() {
        setSavingSummary(false);
        showToast({
          title: t`Successfully saved preferences`,
          description: t`Your preferences have been updated successfully.`,
        });
      },
      onError(error) {
        console.error(error);
        setSavingSummary(false);
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
  function onInteractionScopeSubmit(event: SubmitEvent) {
    event.preventDefault();
    const account = data()?.accountByUsername;
    const id = account?.id;
    if (!id) return;
    setSavingInteractionScope(true);
    saveInteractionScope({
      variables: {
        id,
        defaultNoteVisibility:
          noteVisibility() ?? account.defaultNoteVisibility,
        defaultShareVisibility:
          shareVisibility() ?? account.defaultShareVisibility,
        defaultQuotePolicy: quotePolicyLocked()
          ? "SELF"
          : (quotePolicy() ?? account.defaultQuotePolicy),
      },
      onCompleted() {
        setSavingInteractionScope(false);
        showToast({
          title: t`Successfully saved preferences`,
          description: t`Your preferences have been updated successfully.`,
        });
      },
      onError(error) {
        console.error(error);
        setSavingInteractionScope(false);
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
  function onDigestSubmit(event: SubmitEvent) {
    event.preventDefault();
    const account = data()?.accountByUsername;
    const id = account?.id;
    if (!id) return;
    setSavingDigest(true);
    saveDigest({
      variables: {
        id,
        notificationEmailDigestDaily:
          dailyDigestDiv?.querySelector("input")?.checked ?? false,
        notificationEmailDigestWeekly:
          weeklyDigestDiv?.querySelector("input")?.checked ?? false,
      },
      onCompleted() {
        setSavingDigest(false);
        showToast({
          title: t`Successfully saved preferences`,
          description: t`Your preferences have been updated successfully.`,
        });
      },
      onError(error) {
        console.error(error);
        setSavingDigest(false);
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
    <Show keyed when={data()}>
      {(data) => (
        <>
          {/* `keyed` avoids a "Stale read from <Show>" race when solid-relay
             publishes a fragment snapshot inside `batch()` that flips
             `accountByUsername` to falsy in the same tick as a downstream
             reactive read. Reconcile keeps the account's identity stable
             (`key: "__id"`), so `keyed` only re-mounts on navigation to
             a different account. */}
          <Show keyed when={data.accountByUsername}>
            {(account) => (
              <div class="mt-4 flex flex-col gap-4">
                <form on:submit={onSummarySubmit}>
                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Preferences`}</CardTitle>
                      <CardDescription>
                        {t`Set your personal preferences.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent class="flex flex-col gap-4">
                      <div class="flex items-start space-x-2">
                        <Checkbox
                          id="prefer-ai-summary"
                          ref={preferAiSummaryDiv}
                          defaultChecked={account.preferAiSummary}
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
                      <Button
                        type="submit"
                        class="cursor-pointer self-start"
                        disabled={savingSummary()}
                      >
                        {savingSummary() ? t`Saving…` : t`Save`}
                      </Button>
                    </CardContent>
                  </Card>
                </form>
                <form on:submit={onInteractionScopeSubmit}>
                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Interaction scope`}</CardTitle>
                      <CardDescription>
                        {t`Set the default visibility and quote permissions for new posts.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent class="flex flex-col gap-4">
                      <div class="flex flex-col gap-4 sm:flex-row">
                        <div class="flex min-w-0 grow flex-col gap-1.5">
                          <Label>{t`Default note privacy`}</Label>
                          <PostVisibilitySelect
                            value={
                              noteVisibility() ??
                              (account.defaultNoteVisibility as PostVisibility)
                            }
                            onChange={setNoteVisibility}
                          />
                          <p class="text-sm text-muted-foreground">
                            {t`The default privacy setting for your notes.`}
                          </p>
                        </div>
                        <div class="flex min-w-0 grow flex-col gap-1.5">
                          <Label>{t`Default share privacy`}</Label>
                          <PostVisibilitySelect
                            value={
                              shareVisibility() ??
                              (account.defaultShareVisibility as PostVisibility)
                            }
                            onChange={setShareVisibility}
                          />
                          <p class="text-sm text-muted-foreground">
                            {t`The default privacy setting for your shares.`}
                          </p>
                        </div>
                      </div>
                      <div class="flex flex-col gap-1.5">
                        <Label>{t`Default quote permission`}</Label>
                        <QuotePolicySelect
                          value={
                            quotePolicyLocked()
                              ? "SELF"
                              : (quotePolicy() ??
                                (account.defaultQuotePolicy as QuotePolicy))
                          }
                          onChange={setQuotePolicy}
                          disabled={quotePolicyLocked()}
                        />
                        <p class="text-sm text-muted-foreground">
                          {quotePolicyLocked()
                            ? t`Locked to "Only me" because your default note privacy restricts visibility.`
                            : t`The default quote permission for your notes.`}
                        </p>
                      </div>
                      <Button
                        type="submit"
                        class="cursor-pointer self-start"
                        disabled={savingInteractionScope()}
                      >
                        {savingInteractionScope() ? t`Saving…` : t`Save`}
                      </Button>
                    </CardContent>
                  </Card>
                </form>
                <form on:submit={onDigestSubmit}>
                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Email digests`}</CardTitle>
                      <CardDescription>
                        {t`Receive a summary email when unread notifications remain.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent class="flex flex-col gap-4">
                      <div class="flex items-start space-x-2">
                        <Checkbox
                          id="notification-email-digest-daily"
                          ref={dailyDigestDiv}
                          defaultChecked={account.notificationEmailDigestDaily}
                        />
                        <div class="grid gap-1.5 leading-none">
                          <Label for="notification-email-digest-daily">
                            {t`Daily digest`}
                          </Label>
                          <p class="text-sm text-muted-foreground">
                            {t`Send one email per day while unread notifications remain.`}
                          </p>
                        </div>
                      </div>
                      <div class="flex items-start space-x-2">
                        <Checkbox
                          id="notification-email-digest-weekly"
                          ref={weeklyDigestDiv}
                          defaultChecked={account.notificationEmailDigestWeekly}
                        />
                        <div class="grid gap-1.5 leading-none">
                          <Label for="notification-email-digest-weekly">
                            {t`Weekly digest`}
                          </Label>
                          <p class="text-sm text-muted-foreground">
                            {t`Send one email per week while unread notifications remain.`}
                          </p>
                        </div>
                      </div>
                      <Button
                        type="submit"
                        class="cursor-pointer self-start"
                        disabled={savingDigest()}
                      >
                        {savingDigest() ? t`Saving…` : t`Save`}
                      </Button>
                    </CardContent>
                  </Card>
                </form>
              </div>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
