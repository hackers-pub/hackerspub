import type { Uuid } from "@hackerspub/models/uuid";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { getRequestEvent } from "solid-js/web";
import { createMutation } from "solid-relay";
import { getRequestProtocol, setCookie } from "vinxi/http";
import { Button } from "~/components/ui/button.tsx";
import { Grid } from "~/components/ui/grid.tsx";
import {
  OTPField,
  OTPFieldGroup,
  OTPFieldInput,
  OTPFieldSeparator,
  OTPFieldSlot,
  REGEXP_ONLY_DIGITS_AND_CHARS,
} from "~/components/ui/otp-field.tsx";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type {
  signByEmailMutation,
} from "./__generated__/signByEmailMutation.graphql.ts";
import type {
  signByUsernameMutation,
  signByUsernameMutation$data,
} from "./__generated__/signByUsernameMutation.graphql.ts";
import type { signCompleteMutation } from "./__generated__/signCompleteMutation.graphql.ts";

const signByEmailMutation = graphql`
  mutation signByEmailMutation($locale: Locale!, $email: String!, $verifyUrl: URITemplate!) {
    loginByEmail(locale: $locale, email: $email, verifyUrl: $verifyUrl) {
      ... on LoginChallenge {
        __typename
        account {
          name
          handle
          avatarUrl
        }
        token
      }
      ... on AccountNotFoundError {
        __typename
      }
    }
  }
`;

const signByUsernameMutation = graphql`
  mutation signByUsernameMutation($locale: Locale!, $username: String!, $verifyUrl: URITemplate!) {
    loginByUsername(locale: $locale, username: $username, verifyUrl: $verifyUrl) {
      ... on LoginChallenge {
        __typename
        account {
          name
          handle
          avatarUrl
        }
        token
      }
      ... on AccountNotFoundError {
        __typename
      }
    }
  }
`;

const signCompleteMutation = graphql`
  mutation signCompleteMutation($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) {
      id
    }
  }
`;

const setSessionCookie = async (sessionId: Uuid) => {
  "use server";
  const event = getRequestEvent();
  if (event == null) return false;
  setCookie(event.nativeEvent, "session", sessionId, {
    httpOnly: true,
    path: "/",
    expires: new Date(Date.now() + 365 * 60 * 60 * 24 * 1000), // 365 days
    secure: getRequestProtocol(event.nativeEvent) === "https",
  });
  return true;
};

const enum LoginError {
  ACCOUNT_NOT_FOUND,
  UNKNOWN,
}

export default function SignPage() {
  const { t, i18n } = useLingui();
  let emailInput: HTMLInputElement | undefined;
  let codeInput: HTMLInputElement | undefined;
  const [challenging, setChallenging] = createSignal(false);
  const [email, setEmail] = createSignal("");
  const [errorCode, setErrorCode] = createSignal<
    | LoginError
    | undefined
  >(
    undefined,
  );
  const [token, setToken] = createSignal<Uuid | undefined>(undefined);
  const [loginByEmail] = createMutation<signByEmailMutation>(
    signByEmailMutation,
  );
  const [loginByUsername] = createMutation<signByUsernameMutation>(
    signByUsernameMutation,
  );
  const [complete] = createMutation<signCompleteMutation>(
    signCompleteMutation,
  );
  const [completing, setCompleting] = createSignal(false);

  function onInput() {
    if (emailInput == null) return;
    setEmail(emailInput.value.trim());
    setErrorCode(undefined);
  }

  function onChallengeSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (emailInput == null) return;
    setChallenging(true);
    const email = emailInput.value;
    const searchParams = location == null
      ? new URLSearchParams()
      : new URL(location.href).searchParams;
    const verifyUrl = `${location.origin}/sign/in/{token}?code={code}&next=${
      encodeURIComponent(searchParams.get("next") ?? "/")
    }`;
    if (email.match(/^[^@]+@[^@]+$/)) {
      loginByEmail({
        variables: {
          locale: i18n.locale,
          email,
          verifyUrl,
        },
        onCompleted(response) {
          onCompleted(response.loginByEmail);
        },
        onError(_error) {
          onError();
        },
      });
    } else {
      loginByUsername({
        variables: {
          locale: i18n.locale,
          username: email,
          verifyUrl,
        },
        onCompleted(response) {
          onCompleted(response.loginByUsername);
        },
        onError(_error) {
          onError();
        },
      });
    }
  }

  function onCompleted(data: signByUsernameMutation$data["loginByUsername"]) {
    setChallenging(false);
    if (data.__typename === "LoginChallenge") {
      setToken(data.token);
      codeInput?.focus();
    } else if (
      data.__typename === "AccountNotFoundError"
    ) {
      setErrorCode(LoginError.ACCOUNT_NOT_FOUND);
    } else {
      onError();
    }
  }

  function onError() {
    setChallenging(false);
    setErrorCode(LoginError.UNKNOWN);
    setToken(undefined);
  }

  function getSignInMessage() {
    const currentToken = token();
    const currentErrorCode = errorCode();

    if (currentToken != null) {
      return t`A sign-in link has been sent to your email. Please check your inbox (or spam folder).`;
    }

    switch (currentErrorCode) {
      case LoginError.ACCOUNT_NOT_FOUND:
        return t`No such account in Hackers' Pub—please try again.`;
      case undefined:
      case null:
        return t`Enter your email or username below to sign in.`;
      default:
        return t`Something went wrong—please try again.`;
    }
  }

  function onCodeInput() {
    if (codeInput == null) return;
    codeInput.value = codeInput.value.toUpperCase();
    if (codeInput.value.length === 6) {
      setTimeout(() => {
        setCompleting(true);
        complete({
          variables: {
            code: codeInput.value,
            token: token()!,
          },
          onCompleted(response) {
            if (response.completeLoginChallenge == null) {
              setCompleting(false);
            } else {
              setSessionCookie(response.completeLoginChallenge.id).then(
                (success) => {
                  if (success) {
                    const searchParams = location == null
                      ? new URLSearchParams()
                      : new URL(location.href).searchParams;
                    window.location.href = searchParams.get("next") ?? "/";
                  } else {
                    setCompleting(false);
                  }
                },
              );
            }
          },
        });
      }, 0);
    }
  }

  return (
    <div lang={i18n.locale} class="lg:p-8">
      <div class="mx-auto sm:w-[350px]">
        <div class="flex flex-col space-y-2 text-center">
          <h1 class="text-2xl font-semibold tracking-tight">
            {t`Signing in Hackers' Pub`}
          </h1>
          <p class="text-sm text-muted-foreground">
            {getSignInMessage()}
          </p>
        </div>
        <Show when={token() == null}>
          <form
            class="my-6 grid gap-6"
            on:submit={onChallengeSubmit}
          >
            <Grid class="gap-4">
              <TextField
                validationState={errorCode() ? "invalid" : "valid"}
                class="gap-1"
              >
                <TextFieldLabel class="sr-only">
                  {t`Email or username`}
                </TextFieldLabel>
                <TextFieldInput
                  ref={emailInput}
                  type="text"
                  inputmode="email"
                  tabindex={0}
                  placeholder="me@email.com" // Do not translate
                  on:input={onInput}
                />
              </TextField>
              <Button
                type="submit"
                disabled={challenging() || email().trim() === ""}
                class="cursor-pointer"
              >
                {challenging() ? t`Signing in…` : t`Sign in`}
              </Button>
            </Grid>
          </form>
          <div class="text-center">
            <p class="text-sm text-muted-foreground">
              {t`Do you need an account? Hackers' Pub is invite-only—please ask a friend to invite you.`}
            </p>
          </div>
        </Show>
        <Show when={token() != null}>
          <div class="relative mt-6">
            <div class="absolute inset-0 flex items-center">
              <span class="w-full border-t" />
            </div>
            <div class="relative flex justify-center text-xs uppercase">
              <span class="bg-background px-2 text-muted-foreground">
                {t`Or enter the code from the email`}
              </span>
            </div>
          </div>
          <div class="mx-auto my-6 w-fit">
            <OTPField maxLength={6}>
              <OTPFieldInput
                ref={codeInput}
                pattern={REGEXP_ONLY_DIGITS_AND_CHARS}
                tabindex={0}
                on:input={onCodeInput}
                disabled={completing()}
              />
              <OTPFieldGroup>
                <OTPFieldSlot index={0} />
                <OTPFieldSlot index={1} />
                <OTPFieldSlot index={2} />
              </OTPFieldGroup>
              <OTPFieldSeparator />
              <OTPFieldGroup>
                <OTPFieldSlot index={3} />
                <OTPFieldSlot index={4} />
                <OTPFieldSlot index={5} />
              </OTPFieldGroup>
            </OTPField>
          </div>
        </Show>
      </div>
    </div>
  );
}
