import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, createSignal, For, Show } from "solid-js";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import IconPlus from "~icons/lucide/plus";
import IconTrash2 from "~icons/lucide/trash-2";
import { SettingsContainer } from "~/components/SettingsContainer.tsx";
import { SettingsOwnerGuard } from "~/components/SettingsOwnerGuard.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Title } from "~/components/Title.tsx";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import {
  TextField,
  TextFieldDescription,
  TextFieldErrorMessage,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { removeSessionCookie } from "~/lib/sessionActions.ts";
import type { accountAddMigrationAliasMutation } from "./__generated__/accountAddMigrationAliasMutation.graphql.ts";
import type { accountDeleteMutation } from "./__generated__/accountDeleteMutation.graphql.ts";
import type { accountPageQuery } from "./__generated__/accountPageQuery.graphql.ts";
import type { accountRemoveMigrationAliasMutation } from "./__generated__/accountRemoveMigrationAliasMutation.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

const accountPageQuery = graphql`
  query accountPageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      actor {
        aliases
      }
      ...SettingsTabs_account
    }
  }
`;

const loadAccountPageQuery = routePreloadedQuery(
  (handle: string) =>
    loadQuery<accountPageQuery>(
      useRelayEnvironment()(),
      accountPageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadAccountPageQuery",
);

const accountDeleteMutation = graphql`
  mutation accountDeleteMutation($id: ID!) {
    deleteAccount(input: { id: $id }) {
      __typename
      ... on DeleteAccountPayload {
        deletedAccountId
        username
        deleted
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on AccountDeletionUnavailableError {
        unavailable
      }
    }
  }
`;

const accountAddMigrationAliasMutation = graphql`
  mutation accountAddMigrationAliasMutation($accountId: ID!, $actor: String!) {
    addAccountMigrationAlias(
      input: { accountId: $accountId, actor: $actor }
    ) {
      __typename
      ... on AddAccountMigrationAliasPayload {
        account {
          id
          actor {
            id
            aliases
          }
        }
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`;

const accountRemoveMigrationAliasMutation = graphql`
  mutation accountRemoveMigrationAliasMutation($accountId: ID!, $alias: URL!) {
    removeAccountMigrationAlias(
      input: { accountId: $accountId, alias: $alias }
    ) {
      __typename
      ... on RemoveAccountMigrationAliasPayload {
        account {
          id
          actor {
            id
            aliases
          }
        }
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`;

export default function AccountSettingsPage() {
  const params = useParams();
  const { t } = useLingui();
  const data = createStablePreloadedQuery<accountPageQuery>(
    accountPageQuery,
    () => loadAccountPageQuery(decodeRouteParam(params.handle!)),
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <SettingsOwnerGuard
          accountId={data.accountByUsername?.id}
          viewerId={data.viewer?.id}
        >
          <Show keyed when={data.accountByUsername}>
            {(account) => (
              <>
                <Title>{t`Account settings`}</Title>
                <SettingsContainer class="p-4">
                  <h1 class="sr-only">{t`Account settings`}</h1>
                  <SettingsTabs selected="account" $account={account} />
                  <div class="mt-4 flex flex-col gap-4">
                    <Card>
                      <CardHeader>
                        <CardTitle>{t`Account migration`}</CardTitle>
                        <CardDescription>
                          {t`Prepare this account as the destination for a Mastodon-style move.`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <AccountMigrationAliasesForm
                          id={account.id}
                          aliases={account.actor.aliases}
                        />
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle>{t`Delete account`}</CardTitle>
                        <CardDescription>
                          {t`Permanently delete your account and sign out of this session.`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <AccountDeletionForm
                          id={account.id}
                          username={account.username}
                        />
                      </CardContent>
                    </Card>
                  </div>
                </SettingsContainer>
              </>
            )}
          </Show>
        </SettingsOwnerGuard>
      )}
    </Show>
  );
}

interface AccountMigrationAliasesFormProps {
  aliases: readonly string[];
  id: string;
}

function AccountMigrationAliasesForm(
  props: AccountMigrationAliasesFormProps,
) {
  const { t } = useLingui();
  const [actor, setActor] = createSignal("");
  const [error, setError] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [removingAlias, setRemovingAlias] = createSignal<string | null>(null);
  const canAdd = createMemo(() => actor().trim() !== "" && !adding());
  const [addAlias] = createMutation<accountAddMigrationAliasMutation>(
    accountAddMigrationAliasMutation,
  );
  const [removeAliasMutation] = createMutation<
    accountRemoveMigrationAliasMutation
  >(accountRemoveMigrationAliasMutation);

  function showMutationError(title: string, description: string) {
    showToast({ title, description, variant: "error" });
  }

  function onAdd(event: SubmitEvent) {
    event.preventDefault();
    if (!canAdd()) return;
    const value = actor().trim();
    setError("");
    setAdding(true);
    addAlias({
      variables: {
        accountId: props.id,
        actor: value,
      },
      onCompleted(response) {
        setAdding(false);
        const result = response.addAccountMigrationAlias;
        if (result?.__typename === "AddAccountMigrationAliasPayload") {
          setActor("");
          showToast({
            title: t`Previous account added`,
            description:
              t`Hackers' Pub now publishes the old account as another account that belongs to you.`,
          });
          return;
        }
        if (result?.__typename === "NotAuthenticatedError") {
          showMutationError(
            t`Sign in required`,
            t`Please sign in again before changing account migration settings.`,
          );
          return;
        }
        if (result?.__typename === "NotAuthorizedError") {
          showMutationError(
            t`Cannot update this account`,
            t`You can prepare migration only for your own account.`,
          );
          return;
        }
        const message =
          t`Enter the account you are moving from, such as @old@example.com or its actor URL.`;
        setError(message);
        showMutationError(t`Could not add previous account`, message);
      },
      onError(error) {
        console.error(error);
        setAdding(false);
        showMutationError(
          t`Could not add previous account`,
          t`The previous account could not be added. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
        );
      },
    });
  }

  function onRemove(alias: string) {
    if (removingAlias() != null) return;
    setError("");
    setRemovingAlias(alias);
    removeAliasMutation({
      variables: {
        accountId: props.id,
        alias,
      },
      onCompleted(response) {
        setRemovingAlias(null);
        const result = response.removeAccountMigrationAlias;
        if (result?.__typename === "RemoveAccountMigrationAliasPayload") {
          showToast({
            title: t`Previous account removed`,
            description:
              t`Hackers' Pub no longer publishes that account as another account that belongs to you.`,
          });
          return;
        }
        if (result?.__typename === "NotAuthenticatedError") {
          showMutationError(
            t`Sign in required`,
            t`Please sign in again before changing account migration settings.`,
          );
          return;
        }
        if (result?.__typename === "NotAuthorizedError") {
          showMutationError(
            t`Cannot update this account`,
            t`You can prepare migration only for your own account.`,
          );
          return;
        }
        showMutationError(
          t`Could not remove previous account`,
          t`The previous account could not be removed. Please try again.`,
        );
      },
      onError(error) {
        console.error(error);
        setRemovingAlias(null);
        showMutationError(
          t`Could not remove previous account`,
          t`The previous account could not be removed. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
        );
      },
    });
  }

  return (
    <div class="flex flex-col gap-5">
      <div class="space-y-3 text-sm text-muted-foreground">
        <p>
          {t`This page only prepares the Hackers' Pub side of the move. The move still starts from your old server.`}
        </p>
        <ol class="ml-4 list-decimal space-y-2">
          <li>
            {t`Add the old account here. Hackers' Pub will publish it as another account that belongs to you.`}
          </li>
          <li>
            {t`On the old server, open account migration settings and set this Hackers' Pub account as the new account.`}
          </li>
          <li>
            {t`After the old server confirms the destination, it sends the Move activity and compatible servers can move followers here.`}
          </li>
        </ol>
      </div>

      <form class="flex flex-col gap-4" onSubmit={onAdd}>
        <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <TextField
            value={actor()}
            onChange={(value) => {
              setActor(value);
              if (error() !== "") setError("");
            }}
            validationState={error() === "" ? "valid" : "invalid"}
          >
            <TextFieldLabel>{t`Old account`}</TextFieldLabel>
            <TextFieldInput
              type="text"
              autocomplete="off"
              autocapitalize="none"
              inputmode="email"
              placeholder={t`@old@example.com or actor URL`}
              disabled={adding()}
            />
            <Show
              when={error() !== ""}
              fallback={
                <TextFieldDescription>
                  {t`Enter the account you are moving from, for example @old@example.com.`}
                </TextFieldDescription>
              }
            >
              <TextFieldErrorMessage>{error()}</TextFieldErrorMessage>
            </Show>
          </TextField>
          <Button
            type="submit"
            class="w-full sm:mt-6 sm:w-auto"
            disabled={!canAdd()}
          >
            <IconPlus />
            {adding() ? t`Adding…` : t`Add`}
          </Button>
        </div>
      </form>

      <Show
        when={props.aliases.length > 0}
        fallback={
          <p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t`No previous accounts added yet.`}
          </p>
        }
      >
        <div class="overflow-hidden rounded-md border">
          <For each={props.aliases}>
            {(alias) => (
              <div class="flex flex-col gap-3 border-b p-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                <code class="min-w-0 break-all rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                  {alias}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="w-full shrink-0 sm:w-auto"
                  disabled={removingAlias() != null}
                  aria-label={t`Remove ${alias}`}
                  onClick={() => onRemove(alias)}
                >
                  <IconTrash2 />
                  {removingAlias() === alias ? t`Removing…` : t`Remove`}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

interface AccountDeletionFormProps {
  id: string;
  username: string;
}

function AccountDeletionForm(props: AccountDeletionFormProps) {
  const { t } = useLingui();
  const [confirmation, setConfirmation] = createSignal("");
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const canDelete = createMemo(() =>
    confirmation().trim().toLowerCase() === props.username.toLowerCase() &&
    !deleting()
  );
  const [deleteAccount] = createMutation<accountDeleteMutation>(
    accountDeleteMutation,
  );

  function onDelete() {
    if (!canDelete()) return;
    setDeleting(true);
    deleteAccount({
      variables: { id: props.id },
      onCompleted(response) {
        const result = response.deleteAccount;
        if (result == null) {
          setDeleting(false);
          setConfirmOpen(false);
          showToast({
            title: t`Failed to delete account`,
            description:
              t`The deletion request could not be completed. Please try again.`,
            variant: "error",
          });
          return;
        }
        if (result.__typename === "DeleteAccountPayload") {
          void removeSessionCookie().finally(() => location.replace("/local"));
          return;
        }
        setDeleting(false);
        setConfirmOpen(false);
        if (result.__typename === "AccountDeletionUnavailableError") {
          showToast({
            title: t`Account deletion is unavailable`,
            description:
              t`This account cannot be deleted right now. Please contact the instance administrators.`,
            variant: "error",
          });
          return;
        }
        if (result.__typename === "NotAuthenticatedError") {
          showToast({
            title: t`Sign in required`,
            description: t`Please sign in again before deleting your account.`,
            variant: "error",
          });
          return;
        }
        if (result.__typename === "NotAuthorizedError") {
          showToast({
            title: t`Cannot delete this account`,
            description: t`You can delete only your own account.`,
            variant: "error",
          });
          return;
        }
        showToast({
          title: t`Failed to delete account`,
          description:
            t`The deletion request could not be completed. Please try again.`,
          variant: "error",
        });
      },
      onError(error) {
        console.error(error);
        setDeleting(false);
        setConfirmOpen(false);
        showToast({
          title: t`Failed to delete account`,
          description:
            t`The deletion request could not be completed. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  return (
    <div class="flex flex-col gap-5">
      <div class="rounded-md border border-destructive/35 bg-destructive/5 p-4 text-sm">
        <p class="font-medium text-destructive">
          {t`This action is permanent.`}
        </p>
        <p class="mt-2 text-muted-foreground">
          {t`Your profile, posts, drafts, follows, settings, and login credentials will be removed. Your current username will remain reserved.`}
        </p>
      </div>

      <TextField
        value={confirmation()}
        onChange={setConfirmation}
      >
        <TextFieldLabel>{t`Username`}</TextFieldLabel>
        <TextFieldInput
          autocomplete="off"
          autocapitalize="none"
          inputmode="text"
          placeholder={props.username}
        />
        <TextFieldDescription>
          {t`Type ${props.username} to confirm account deletion.`}
        </TextFieldDescription>
      </TextField>

      <div>
        <Button
          type="button"
          variant="destructive"
          disabled={!canDelete()}
          onClick={() => setConfirmOpen(true)}
        >
          <IconTrash2 />
          {t`Delete account`}
        </Button>
      </div>

      <AlertDialog open={confirmOpen()} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t`Delete account permanently?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t`This cannot be undone. Your account will be deleted and you will be signed out.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={deleting()}>
              {t`Cancel`}
            </AlertDialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={!canDelete()}
              onClick={onDelete}
            >
              <IconTrash2 />
              {deleting() ? t`Deleting…` : t`Delete account`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
