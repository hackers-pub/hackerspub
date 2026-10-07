import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { Title } from "~/components/Title.tsx";
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
import { useLingui } from "~/lib/i18n/macro.ts";
import { runPrivateMutation } from "~/lib/privateMutation.ts";
import type { recoveryLoginMutation } from "./__generated__/recoveryLoginMutation.graphql.ts";
import type { recoveryGetOptionsMutation } from "./__generated__/recoveryGetOptionsMutation.graphql.ts";
import type { recoveryRegisterMutation } from "./__generated__/recoveryRegisterMutation.graphql.ts";

const loginMutation = graphql`
  mutation recoveryLoginMutation($username: String!, $code: String!) {
    loginByRecoveryCode(username: $username, code: $code) {
      __typename
      ... on RecoveryLoginPayload { session { id account { id username } } registrationToken }
      ... on AccountBannedError { since }
    }
  }
`;
const optionsMutation = graphql`
  mutation recoveryGetOptionsMutation($accountId: ID!) {
    getPasskeyRegistrationOptions(accountId: $accountId)
  }
`;
const registerMutation = graphql`
  mutation recoveryRegisterMutation($accountId: ID!, $name: String!, $registrationResponse: JSON!, $recoveryRegistrationToken: String!) {
    verifyPasskeyRegistration(accountId: $accountId, name: $name, registrationResponse: $registrationResponse, recoveryRegistrationToken: $recoveryRegistrationToken) { verified }
  }
`;
interface RecoveryRegistration {
  accountId: string;
  username: string;
  token: string;
}
export default function RecoveryPage() {
  const { t, i18n } = useLingui();
  const [username, setUsername] = createSignal("");
  const [code, setCode] = createSignal("");
  const [name, setName] = createSignal("");
  const [registration, setRegistration] = createSignal<RecoveryRegistration>();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  async function recover(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await runPrivateMutation<recoveryLoginMutation>(
        loginMutation,
        { username: username().trim().replace(/^@/, ""), code: code() },
      );
      const result = response.loginByRecoveryCode;
      if (result?.__typename !== "RecoveryLoginPayload") {
        setMessage(
          result?.__typename === "AccountBannedError"
            ? t`This account is permanently suspended.`
            : t`Recovery sign-in failed. Check your username and use an unused recovery code.`,
        );
        return;
      }
      // The server function has already replaced the HttpOnly cookie. The grant
      // is temporary authority, kept separately from the ordinary session.
      setCode("");
      setRegistration({
        accountId: result.session.account.id,
        username: result.session.account.username,
        token: result.registrationToken,
      });
    } catch {
      setMessage(
        t`Recovery sign-in failed. Check your username and use an unused recovery code.`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function register(event: SubmitEvent) {
    event.preventDefault();
    const pending = registration();
    if (pending == null) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await runPrivateMutation<recoveryGetOptionsMutation>(
        optionsMutation,
        { accountId: pending.accountId },
      );
      const registrationResponse = await startRegistration({
        optionsJSON:
          response.getPasskeyRegistrationOptions as PublicKeyCredentialCreationOptionsJSON,
      });
      const result = await runPrivateMutation<recoveryRegisterMutation>(
        registerMutation,
        {
          accountId: pending.accountId,
          name: name().trim(),
          registrationResponse,
          recoveryRegistrationToken: pending.token,
        },
      );
      if (!result.verifyPasskeyRegistration.verified)
        throw new Error("Registration failed.");
      setRegistration(undefined);
      window.location.href = `/@${encodeURIComponent(pending.username)}/settings/passkeys?lang=${encodeURIComponent(i18n.locale)}`;
    } catch (error) {
      setMessage(
        error instanceof Error && error.name === "NotAllowedError"
          ? t`Passkey registration was cancelled or timed out. Try again without entering another recovery code.`
          : t`Passkey registration failed. Try again. Sign in with another recovery code if the registration authorization has expired.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="mx-auto w-full max-w-lg p-4 py-8">
      <Title>{t`Account recovery`}</Title>
      <Card>
        <CardHeader>
          <CardTitle>{t`Account recovery`}</CardTitle>
          <CardDescription>{t`Use a saved recovery code if you cannot use any of your passkeys. Email sign-in remains disabled.`}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <Show when={message()}>
            <p role="alert" class="text-destructive">
              {message()}
            </p>
          </Show>
          <Show
            when={registration() == null}
            fallback={
              <form onSubmit={register} class="space-y-4">
                <p>{t`Register a replacement passkey`}</p>
                <TextField value={name()} onChange={setName}>
                  <TextFieldLabel>{t`Passkey name`}</TextFieldLabel>
                  <TextFieldInput disabled={busy()} autocomplete="off" />
                </TextField>
                <Button
                  type="submit"
                  disabled={busy() || name().trim() === ""}
                >{t`Register a passkey`}</Button>
                <p class="text-sm text-muted-foreground">{t`The registration authorization works once and expires in ten minutes. If you leave now, use another recovery code to start again.`}</p>
              </form>
            }
          >
            <form onSubmit={recover} class="space-y-4">
              <TextField value={username()} onChange={setUsername}>
                <TextFieldLabel>{t`Username`}</TextFieldLabel>
                <TextFieldInput disabled={busy()} autocomplete="username" />
              </TextField>
              <TextField value={code()} onChange={setCode}>
                <TextFieldLabel>{t`Recovery code`}</TextFieldLabel>
                <TextFieldInput
                  type="password"
                  disabled={busy()}
                  autocomplete="off"
                  spellcheck={false}
                />
              </TextField>
              <Button
                type="submit"
                disabled={
                  busy() || username().trim() === "" || code().trim() === ""
                }
              >{t`Sign in with a recovery code`}</Button>
            </form>
          </Show>
          <a href="/sign" class="block underline">{t`Back to sign-in`}</a>
        </CardContent>
      </Card>
    </div>
  );
}
