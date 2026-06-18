import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, createSignal, Show } from "solid-js";
import { getRequestEvent } from "solid-js/web";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import IconTrash2 from "~icons/lucide/trash-2";
import { SettingsCardPage } from "~/components/SettingsCardPage.tsx";
import { SettingsOwnerGuard } from "~/components/SettingsOwnerGuard.tsx";
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
  TextField,
  TextFieldDescription,
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
import {
  buildExpiredSessionSetCookieHeader,
  isSecureRequest,
} from "~/lib/sessionCookie.ts";
import type { accountDeleteMutation } from "./__generated__/accountDeleteMutation.graphql.ts";
import type { accountPageQuery } from "./__generated__/accountPageQuery.graphql.ts";

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

async function removeSessionCookie(): Promise<void> {
  "use server";
  const event = getRequestEvent();
  if (event == null) return;
  event.response.headers.append(
    "Set-Cookie",
    buildExpiredSessionSetCookieHeader({
      secure: isSecureRequest(event.request),
    }),
  );
}

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
              <SettingsCardPage
                selected="account"
                title={t`Account settings`}
                cardTitle={t`Delete account`}
                description={t`Permanently delete your account and sign out of this session.`}
                $account={account}
              >
                <AccountDeletionForm
                  id={account.id}
                  username={account.username}
                />
              </SettingsCardPage>
            )}
          </Show>
        </SettingsOwnerGuard>
      )}
    </Show>
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
    confirmation() === props.username && !deleting()
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
