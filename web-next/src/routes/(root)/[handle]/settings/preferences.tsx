import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, createSignal, Show } from "solid-js";
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
import {
  type QuotePolicy,
  QuotePolicySelect,
} from "~/components/QuotePolicySelect.tsx";
import { SettingsCardPage } from "~/components/SettingsCardPage.tsx";
import { SettingsOwnerGuard } from "~/components/SettingsOwnerGuard.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Checkbox } from "~/components/ui/checkbox.tsx";
import { Label } from "~/components/ui/label.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { preferencesMutation } from "./__generated__/preferencesMutation.graphql.ts";
import type { preferencesPageQuery } from "./__generated__/preferencesPageQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

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
      preferAiSummary
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

const preferencesMutation = graphql`
  mutation preferencesMutation(
    $id: ID!,
    $preferAiSummary: Boolean!,
    $defaultNoteVisibility: PostVisibility!,
    $defaultShareVisibility: PostVisibility!,
    $defaultQuotePolicy: QuotePolicy!
  ) {
    updateAccount(input: {
      id: $id,
      preferAiSummary: $preferAiSummary,
      defaultNoteVisibility: $defaultNoteVisibility,
      defaultShareVisibility: $defaultShareVisibility,
      defaultQuotePolicy: $defaultQuotePolicy,
    }) {
      account {
        id
        preferAiSummary
        defaultNoteVisibility
        defaultShareVisibility
        defaultQuotePolicy
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
    () => loadPreferencesPageQuery(params.handle!),
  );
  const [noteVisibility, setNoteVisibility] = createSignal<
    PostVisibility | undefined
  >(undefined);
  const [shareVisibility, setShareVisibility] = createSignal<
    PostVisibility | undefined
  >(undefined);
  const [quotePolicy, setQuotePolicy] = createSignal<
    QuotePolicy | undefined
  >(undefined);
  const quotePolicyLocked = createMemo(() => {
    const account = data()?.accountByUsername;
    const vis = noteVisibility() ?? account?.defaultNoteVisibility;
    return vis === "FOLLOWERS" || vis === "DIRECT";
  });
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
        defaultQuotePolicy: quotePolicyLocked()
          ? "SELF"
          : (quotePolicy() ?? account.defaultQuotePolicy),
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
                selected="preferences"
                title={t`Preferences`}
                cardTitle={t`Preferences`}
                description={t`Set your personal preferences.`}
                $account={account}
              >
                <form on:submit={onSubmit} class="flex flex-col gap-4">
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
                  <div class="flex flex-col gap-4 sm:flex-row">
                    <div class="flex min-w-0 grow flex-col gap-1.5">
                      <Label>{t`Default note privacy`}</Label>
                      <PostVisibilitySelect
                        value={noteVisibility() ??
                          account
                            .defaultNoteVisibility as PostVisibility}
                        onChange={setNoteVisibility}
                      />
                      <p class="text-sm text-muted-foreground">
                        {t`The default privacy setting for your notes.`}
                      </p>
                    </div>
                    <div class="flex min-w-0 grow flex-col gap-1.5">
                      <Label>{t`Default share privacy`}</Label>
                      <PostVisibilitySelect
                        value={shareVisibility() ??
                          account
                            .defaultShareVisibility as PostVisibility}
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
                      value={quotePolicyLocked() ? "SELF" : (quotePolicy() ??
                        account.defaultQuotePolicy as QuotePolicy)}
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
                    class="cursor-pointer"
                    disabled={saving()}
                  >
                    {saving() ? t`Saving…` : t`Save`}
                  </Button>
                </form>
              </SettingsCardPage>
            )}
          </Show>
        </SettingsOwnerGuard>
      )}
    </Show>
  );
}
