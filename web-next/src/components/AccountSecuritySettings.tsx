import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment, useRelayEnvironment } from "solid-relay";
import { Button } from "./ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  commitPrivatePayload,
  runPrivateMutation,
} from "~/lib/privateMutation.ts";
import { getSecurityProof } from "~/lib/securityProof.ts";
import type { AccountSecuritySettings_account$key } from "./__generated__/AccountSecuritySettings_account.graphql.ts";
import type { AccountSecuritySettingsEnableMutation } from "./__generated__/AccountSecuritySettingsEnableMutation.graphql.ts";
import type { AccountSecuritySettingsDisableMutation } from "./__generated__/AccountSecuritySettingsDisableMutation.graphql.ts";
import type { AccountSecuritySettingsRegenerateMutation } from "./__generated__/AccountSecuritySettingsRegenerateMutation.graphql.ts";

const fragment = graphql`
  fragment AccountSecuritySettings_account on Account {
    emailLoginEnabled
    recoveryCodeCount
  }
`;
const enableMutation = graphql`
  mutation AccountSecuritySettingsEnableMutation($input: EnableAccountPasskeyOnlyInput!) {
    enableAccountPasskeyOnly(input: $input) {
      __typename
      ... on EnableAccountPasskeyOnlyPayload {
        account { id ...AccountSecuritySettings_account }
        session { id }
        recoveryCodes
      }
      ... on AccountSecurityError { code }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`;
const disableMutation = graphql`
  mutation AccountSecuritySettingsDisableMutation($input: DisableAccountPasskeyOnlyInput!) {
    disableAccountPasskeyOnly(input: $input) {
      __typename
      ... on DisableAccountPasskeyOnlyPayload { account { id ...AccountSecuritySettings_account } }
      ... on AccountSecurityError { code }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`;
const regenerateMutation = graphql`
  mutation AccountSecuritySettingsRegenerateMutation($input: RegenerateAccountRecoveryCodesInput!) {
    regenerateAccountRecoveryCodes(input: $input) {
      __typename
      ... on RegenerateAccountRecoveryCodesPayload { account { id ...AccountSecuritySettings_account } recoveryCodes }
      ... on AccountSecurityError { code }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`;
interface AccountSecuritySettingsProps {
  $account: AccountSecuritySettings_account$key;
  onRecoveryCodes: (codes: readonly string[]) => void;
}
export function AccountSecuritySettings(props: AccountSecuritySettingsProps) {
  const { t, i18n } = useLingui();
  const account = createFragment(fragment, () => props.$account);
  const environment = useRelayEnvironment();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  async function change(action: "ENABLE" | "DISABLE" | "REGENERATE") {
    setBusy(true);
    setMessage("");
    try {
      const proof = await getSecurityProof(action);
      const input = { ...proof, locale: i18n.locale };
      if (action === "ENABLE") {
        const response =
          await runPrivateMutation<AccountSecuritySettingsEnableMutation>(
            enableMutation,
            { input },
          );
        const result = response.enableAccountPasskeyOnly;
        if (result.__typename !== "EnableAccountPasskeyOnlyPayload")
          throw new Error(
            result.__typename === "AccountSecurityError"
              ? result.code
              : "NOT_AUTHENTICATED",
          );
        props.onRecoveryCodes(result.recoveryCodes);
        // Only the safe account data enters Relay; plaintext codes never do.
        commitPrivatePayload<AccountSecuritySettingsEnableMutation>(
          environment(),
          enableMutation,
          { input },
          { enableAccountPasskeyOnly: { ...result, recoveryCodes: [] } },
        );
      } else if (action === "DISABLE") {
        const response =
          await runPrivateMutation<AccountSecuritySettingsDisableMutation>(
            disableMutation,
            { input },
          );
        const result = response.disableAccountPasskeyOnly;
        if (result.__typename !== "DisableAccountPasskeyOnlyPayload")
          throw new Error(
            result.__typename === "AccountSecurityError"
              ? result.code
              : "NOT_AUTHENTICATED",
          );
        commitPrivatePayload<AccountSecuritySettingsDisableMutation>(
          environment(),
          disableMutation,
          { input },
          response,
        );
      } else {
        const response =
          await runPrivateMutation<AccountSecuritySettingsRegenerateMutation>(
            regenerateMutation,
            { input },
          );
        const result = response.regenerateAccountRecoveryCodes;
        if (result.__typename !== "RegenerateAccountRecoveryCodesPayload")
          throw new Error(
            result.__typename === "AccountSecurityError"
              ? result.code
              : "NOT_AUTHENTICATED",
          );
        props.onRecoveryCodes(result.recoveryCodes);
        commitPrivatePayload<AccountSecuritySettingsRegenerateMutation>(
          environment(),
          regenerateMutation,
          { input },
          { regenerateAccountRecoveryCodes: { ...result, recoveryCodes: [] } },
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error && error.message === "PASSKEY_REQUIRED"
          ? t`Register at least one passkey before disabling email sign-in.`
          : t`Security verification failed. Please try again with a registered passkey.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t`Sign-in security`}</CardTitle>
        <CardDescription>{t`Use passkeys only to protect your account even if someone gains access to your email.`}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <p>
          {account()?.emailLoginEnabled === false
            ? t`Email sign-in is disabled.`
            : t`Email sign-in is enabled.`}
        </p>
        <p class="text-sm text-muted-foreground">{t`Keep at least one registered passkey. Security changes require a fresh passkey verification. Email cannot recover this account while email sign-in is disabled.`}</p>
        <Show when={message()}>
          <p role="alert" class="text-destructive">
            {message()}
          </p>
        </Show>
        <Show
          when={account()?.emailLoginEnabled === false}
          fallback={
            <>
              <p class="text-sm text-muted-foreground">{t`Disabling email sign-in signs out email sessions and shows ten recovery codes once. Save them offline before leaving this page.`}</p>
              <Button
                disabled={busy()}
                onClick={() => change("ENABLE")}
              >{t`Disable email sign-in`}</Button>
            </>
          }
        >
          <p class="text-sm text-muted-foreground">{t`Unused recovery codes: ${account()?.recoveryCodeCount ?? 0}`}</p>
          <div class="flex flex-wrap gap-2">
            <Button
              disabled={busy()}
              onClick={() => change("DISABLE")}
            >{t`Enable email sign-in`}</Button>
            <Button
              variant="outline"
              disabled={busy()}
              onClick={() => change("REGENERATE")}
            >{t`Regenerate recovery codes`}</Button>
          </div>
          <p class="text-sm text-muted-foreground">{t`Regenerating recovery codes invalidates every previous code.`}</p>
        </Show>
      </CardContent>
    </Card>
  );
}
