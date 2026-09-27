import { useLocation } from "@solidjs/router";
import { graphql } from "relay-runtime";
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.tsx";
import { Badge } from "~/components/ui/badge.tsx";
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
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { createHydrationStableMemo } from "~/lib/hydrationStableMemo.ts";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { AccountEmailSettings_account$key } from "./__generated__/AccountEmailSettings_account.graphql.ts";
import type { AccountEmailSettingsRequestMutation } from "./__generated__/AccountEmailSettingsRequestMutation.graphql.ts";
import type { AccountEmailSettingsVerifyMutation } from "./__generated__/AccountEmailSettingsVerifyMutation.graphql.ts";
import type { AccountEmailSettingsPrimaryMutation } from "./__generated__/AccountEmailSettingsPrimaryMutation.graphql.ts";
import type { AccountEmailSettingsRemoveMutation } from "./__generated__/AccountEmailSettingsRemoveMutation.graphql.ts";

const fragment = graphql`
  fragment AccountEmailSettings_account on Account {
    id
    emails { email primary verified }
    emailManagementAvailableUntil
  }
`;
const requestMutation = graphql`
  mutation AccountEmailSettingsRequestMutation($email: Email!, $locale: Locale!) {
    requestAccountEmailVerification(input: { email: $email, locale: $locale }) {
      __typename
      ... on RequestAccountEmailVerificationPayload { token expires }
      ... on AccountEmailError { code retryAfter }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`;
const verifyMutation = graphql`
  mutation AccountEmailSettingsVerifyMutation($token: UUID!, $code: String!) {
    verifyAccountEmail(input: { token: $token, code: $code }) {
      __typename
      ... on VerifyAccountEmailPayload { account { ...AccountEmailSettings_account } }
      ... on AccountEmailError { code retryAfter }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`;
const primaryMutation = graphql`
  mutation AccountEmailSettingsPrimaryMutation($email: Email!) {
    setPrimaryAccountEmail(input: { email: $email }) {
      __typename
      ... on SetPrimaryAccountEmailPayload { account { ...AccountEmailSettings_account } }
      ... on AccountEmailError { code retryAfter }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`;
const removeMutation = graphql`
  mutation AccountEmailSettingsRemoveMutation($email: Email!) {
    removeAccountEmail(input: { email: $email }) {
      __typename
      ... on RemoveAccountEmailPayload { account { ...AccountEmailSettings_account } }
      ... on AccountEmailError { code retryAfter }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`;

interface AccountEmailSettingsProps {
  $account: AccountEmailSettings_account$key;
}
interface PendingVerification {
  token: AccountEmailSettingsVerifyMutation["variables"]["token"];
  email: string;
  expires: string;
}
interface MutationResult {
  __typename: string;
  code?: string;
  retryAfter?: number | null;
}

export function AccountEmailSettings(props: AccountEmailSettingsProps) {
  const { t, i18n } = useLingui();
  const location = useLocation();
  const data = createFragment(fragment, () => props.$account);
  const account = createHydrationStableMemo(() => data());
  const [request, requesting] =
    createMutation<AccountEmailSettingsRequestMutation>(requestMutation);
  const [verify, verifying] =
    createMutation<AccountEmailSettingsVerifyMutation>(verifyMutation);
  const [primary, changingPrimary] =
    createMutation<AccountEmailSettingsPrimaryMutation>(primaryMutation);
  const [remove, removing] =
    createMutation<AccountEmailSettingsRemoveMutation>(removeMutation);
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [pending, setPending] = createSignal<PendingVerification>();
  const [removeTarget, setRemoveTarget] = createSignal<string>();
  const [message, setMessage] = createSignal("");
  const [reauthenticationRequired, setReauthenticationRequired] =
    createSignal(false);
  const [now, setNow] = createSignal(0);
  const [retryUntil, setRetryUntil] = createSignal(0);
  onMount(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const fresh = createMemo(
    () =>
      !reauthenticationRequired() &&
      account()?.emailManagementAvailableUntil != null &&
      new Date(account()!.emailManagementAvailableUntil!).getTime() > now(),
  );
  const busy = () =>
    requesting() || verifying() || changingPrimary() || removing();
  const verifiedCount = () =>
    account()?.emails?.filter((email) => email.verified != null).length ?? 0;
  const retrySeconds = () =>
    Math.max(0, Math.ceil((retryUntil() - now()) / 1000));
  const requestDisabled = () =>
    !fresh() || busy() || verifiedCount() >= 5 || retrySeconds() > 0;

  function errorMessage(error: string | undefined): string {
    switch (error) {
      case "INVALID_EMAIL":
        return t`Enter a valid email address.`;
      case "ALREADY_REGISTERED":
        return t`This email address is already verified on your account.`;
      case "UNAVAILABLE":
        return t`This email address is unavailable.`;
      case "NOT_FOUND":
        return t`This email address is not on your account.`;
      case "UNVERIFIED":
        return t`Verify this email address before making it primary.`;
      case "LIMIT_REACHED":
        return t`You can register up to five verified email addresses.`;
      case "RATE_LIMITED":
        return t`Too many verification emails were requested. Please try again later.`;
      case "INVALID_CODE":
        return t`The code is incorrect, expired, or no longer available. Request a new code if needed.`;
      case "REAUTHENTICATION_REQUIRED":
        return t`For security, adding or removing an email address or changing your primary address requires a sign-in within the last 10 minutes. Sign in again with a registered email address or passkey.`;
      case "PRIMARY_EMAIL":
        return t`Choose another primary email address before removing this one.`;
      case "LAST_EMAIL":
        return t`You cannot remove your last verified email address.`;
      case "DELIVERY_FAILED":
        return t`The verification email could not be sent. Please try again later.`;
      default:
        return t`Your email settings could not be updated. Please try again.`;
    }
  }
  function failed(result?: MutationResult | null) {
    if (
      result?.__typename === "NotAuthenticatedError" ||
      result?.code === "REAUTHENTICATION_REQUIRED"
    )
      setReauthenticationRequired(true);
    if (result?.retryAfter != null)
      setRetryUntil(Date.now() + result.retryAfter * 1000);
    setMessage(errorMessage(result?.code));
  }
  function requestVerification(address: string) {
    if (requestDisabled()) return;
    setMessage("");
    request({
      variables: { email: address, locale: i18n.locale },
      onCompleted(response, errors) {
        const result = response.requestAccountEmailVerification;
        if (
          errors?.length ||
          result?.__typename !== "RequestAccountEmailVerificationPayload"
        ) {
          failed(result);
          return;
        }
        setPending({
          token: result.token,
          email: address,
          expires: result.expires,
        });
        setCode("");
      },
      onError() {
        failed();
      },
    });
  }
  function confirmVerification(event: SubmitEvent) {
    event.preventDefault();
    const challenge = pending();
    if (challenge == null || busy()) return;
    setMessage("");
    verify({
      variables: { token: challenge.token, code: code() },
      onCompleted(response, errors) {
        const result = response.verifyAccountEmail;
        if (
          errors?.length ||
          result?.__typename !== "VerifyAccountEmailPayload"
        ) {
          failed(result);
          return;
        }
        setPending(undefined);
        setCode("");
        setEmail("");
        showToast({ title: t`Email address verified` });
      },
      onError() {
        failed();
      },
    });
  }
  function makePrimary(address: string) {
    if (!fresh() || busy()) return;
    setMessage("");
    primary({
      variables: { email: address },
      onCompleted(response, errors) {
        const result = response.setPrimaryAccountEmail;
        if (
          errors?.length ||
          result?.__typename !== "SetPrimaryAccountEmailPayload"
        ) {
          failed(result);
          return;
        }
        showToast({ title: t`Primary email address changed` });
      },
      onError() {
        failed();
      },
    });
  }
  function confirmRemoval() {
    const address = removeTarget();
    if (address == null || !fresh() || busy()) return;
    setMessage("");
    remove({
      variables: { email: address },
      onCompleted(response, errors) {
        setRemoveTarget(undefined);
        const result = response.removeAccountEmail;
        if (
          errors?.length ||
          result?.__typename !== "RemoveAccountEmailPayload"
        ) {
          failed(result);
          return;
        }
        showToast({ title: t`Email address removed` });
      },
      onError() {
        setRemoveTarget(undefined);
        failed();
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t`Email addresses`}</CardTitle>
        <CardDescription>{t`Sign in with any verified email address. Notification digests are sent to your primary address.`}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-5">
        <ul class="divide-y">
          <For each={account()?.emails ?? []}>
            {(address) => (
              <li class="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <span class="break-all text-sm">{address.email}</span>
                  <Show when={address.primary}>
                    <Badge variant="secondary">{t`Primary`}</Badge>
                  </Show>
                  <Show when={address.verified == null}>
                    <Badge variant="warning">{t`Unverified`}</Badge>
                  </Show>
                </div>
                <div class="flex shrink-0 flex-wrap gap-2">
                  <Show when={!address.primary && address.verified != null}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!fresh() || busy()}
                      onClick={() => makePrimary(address.email)}
                    >{t`Make primary`}</Button>
                  </Show>
                  <Show when={address.verified == null}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={requestDisabled()}
                      onClick={() => requestVerification(address.email)}
                    >{t`Verify email`}</Button>
                  </Show>
                  <Show when={!address.primary}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={
                        !fresh() ||
                        busy() ||
                        (address.verified != null && verifiedCount() <= 1)
                      }
                      onClick={() => setRemoveTarget(address.email)}
                      aria-label={t`Remove ${address.email}`}
                    >{t`Remove`}</Button>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
        <Show when={!fresh()}>
          <div class="rounded-md border bg-muted/30 p-3 text-sm">
            <p>{t`For security, adding or removing an email address or changing your primary address requires a sign-in within the last 10 minutes. Sign in again with a registered email address or passkey.`}</p>
            <Button
              as="a"
              href={`/sign?next=${encodeURIComponent(location.pathname)}`}
              variant="outline"
              size="sm"
              class="mt-3"
            >{t`Sign in again`}</Button>
          </div>
        </Show>
        <Show when={message()}>
          <p role="alert" class="text-sm text-error-foreground">
            {message()}
          </p>
        </Show>
        <Show when={retrySeconds() > 0}>
          <p
            role="status"
            class="text-sm text-muted-foreground"
          >{t`You can request another code in ${retrySeconds()} seconds.`}</p>
        </Show>
        <Show
          when={pending()}
          fallback={
            <form
              class="space-y-3 border-t pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                requestVerification(email().trim());
              }}
            >
              <TextField
                value={email()}
                onChange={setEmail}
                disabled={requestDisabled()}
              >
                <TextFieldLabel>{t`New email address`}</TextFieldLabel>
                <TextFieldInput
                  type="email"
                  autocomplete="email"
                  autocapitalize="none"
                  required
                  maxlength={254}
                />
              </TextField>
              <Button
                type="submit"
                variant="outline"
                disabled={requestDisabled()}
              >
                {requesting() ? t`Sending…` : t`Send verification code`}
              </Button>
              <Show when={verifiedCount() >= 5}>
                <p class="text-sm text-muted-foreground">{t`You can register up to five verified email addresses.`}</p>
              </Show>
            </form>
          }
        >
          {(challenge) => (
            <form
              class="space-y-3 border-t pt-4"
              onSubmit={confirmVerification}
            >
              <p
                role="status"
                class="text-sm"
              >{t`Enter the verification code sent to ${challenge().email} in this tab.`}</p>
              <p class="text-sm text-muted-foreground">{t`The code expires at ${new Date(challenge().expires).toLocaleTimeString(i18n.locale, { hour: "numeric", minute: "2-digit" })}.`}</p>
              <TextField
                value={code()}
                onChange={(value) => setCode(value.toUpperCase())}
                disabled={busy()}
              >
                <TextFieldLabel>{t`Verification code`}</TextFieldLabel>
                <TextFieldInput
                  autocomplete="one-time-code"
                  autocapitalize="characters"
                  spellcheck={false}
                  maxlength={8}
                  minlength={8}
                  required
                />
              </TextField>
              <div class="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  disabled={busy() || code().trim().length !== 8}
                >
                  {verifying() ? t`Verifying…` : t`Verify email`}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy()}
                  onClick={() => {
                    setPending(undefined);
                    setMessage("");
                  }}
                >{t`Cancel`}</Button>
              </div>
            </form>
          )}
        </Show>
        <p class="text-xs text-muted-foreground">{t`Keep access to at least one verified email address or passkey. Accounts cannot normally be recovered if all authentication methods are lost.`}</p>
        <AlertDialog
          open={removeTarget() != null}
          onOpenChange={(open) => {
            if (!open && !removing()) setRemoveTarget(undefined);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t`Remove email address?`}</AlertDialogTitle>
              <AlertDialogDescription>{t`You will no longer be able to sign in with ${removeTarget() ?? ""}.`}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose
                disabled={removing()}
              >{t`Cancel`}</AlertDialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={!fresh() || busy()}
                onClick={confirmRemoval}
              >
                {removing() ? t`Removing…` : t`Remove`}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
