import {
  validateBio,
  validateDisplayName,
  validateUsername,
} from "@hackerspub/models/userValidation";
import type { Uuid } from "@hackerspub/models/uuid";
import { validateUuid } from "@hackerspub/models/uuid";
import { type RouteSectionProps } from "@solidjs/router";
import { fetchQuery, graphql } from "relay-runtime";
import { createEffect, createSignal, Show } from "solid-js";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import { createStablePreloadedQuery } from "~/lib/relayPreload.ts";
import { DocumentView } from "~/components/DocumentView.tsx";
import { MarkdownEditor } from "~/components/MarkdownEditor.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { createEnvironment } from "~/RelayEnvironment.tsx";
import type { TokenCodeOfConductQuery } from "./__generated__/TokenCodeOfConductQuery.graphql.ts";
import type {
  SignupBioError,
  SignupDisplayNameError,
  SignupUsernameError,
  TokenCompleteSignupMutation,
} from "./__generated__/TokenCompleteSignupMutation.graphql.ts";
import type { TokenVerifySignupTokenQuery } from "./__generated__/TokenVerifySignupTokenQuery.graphql.ts";

const verifySignupTokenQuery = graphql`
  query TokenVerifySignupTokenQuery($token: UUID!, $code: String!) {
    verifySignupToken(token: $token, code: $code) {
      email
      inviter {
        name
        handle
        avatarUrl
        actor {
          handleHost
        }
      }
    }
  }
`;

const completeSignupMutation = graphql`
  mutation TokenCompleteSignupMutation($token: UUID!, $code: String!, $input: SignupInput!) {
    completeSignup(token: $token, code: $code, input: $input) {
      __typename
      ... on Session {
        id
        account {
          id
          name
          username
          bio
        }
      }
      ... on SignupValidationErrors {
        username
        name
        bio
      }
    }
  }
`;

const codeOfConductQuery = graphql`
  query TokenCodeOfConductQuery($locale: Locale!) {
    codeOfConduct(locale: $locale) {
      ...DocumentView_document
    }
  }
`;

type SignupInfo = NonNullable<
  TokenVerifySignupTokenQuery["response"]["verifySignupToken"]
>;

export default function SignupPage(props: RouteSectionProps) {
  const { t, i18n } = useLingui();
  const [signupInfo, setSignupInfo] = createSignal<SignupInfo | null>(null);
  const [verifying, setVerifying] = createSignal(true);
  const [invalid, setInvalid] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [agreedToCoC, setAgreedToCoC] = createSignal(false);
  const [bio, setBio] = createSignal("");
  const [fieldErrors, setFieldErrors] = createSignal({
    username: null as SignupUsernameError | null,
    name: null as SignupDisplayNameError | null,
    bio: null as SignupBioError | null,
  });

  const codeOfConductData = createStablePreloadedQuery<TokenCodeOfConductQuery>(
    codeOfConductQuery,
    () =>
      loadQuery<TokenCodeOfConductQuery>(
        useRelayEnvironment()(),
        codeOfConductQuery,
        { locale: i18n.locale },
      ),
  );

  let usernameInput: HTMLInputElement | undefined;
  let nameInput: HTMLInputElement | undefined;

  const [completeSignup] = createMutation<TokenCompleteSignupMutation>(
    completeSignupMutation,
  );

  // Helper functions to convert errors to display strings
  const getUsernameErrorMessage = (error: SignupUsernameError | null) => {
    if (!error) return "";

    switch (error) {
      case "USERNAME_REQUIRED":
        return t`Username is required.`;
      case "USERNAME_TOO_LONG":
        return t`Username is too long. Maximum length is 15 characters.`;
      case "USERNAME_INVALID_CHARACTERS":
        return t`Username can only contain lowercase letters, numbers, and underscores.`;
      case "USERNAME_ALREADY_TAKEN":
        return t`Username is already taken.`;
      default:
        return "";
    }
  };

  const getDisplayNameErrorMessage = (error: SignupDisplayNameError | null) => {
    if (!error) return "";

    switch (error) {
      case "DISPLAY_NAME_REQUIRED":
        return t`Name is required.`;
      case "DISPLAY_NAME_TOO_LONG":
        return t`Name is too long. Maximum length is 50 characters.`;
      default:
        return "";
    }
  };

  const getBioErrorMessage = (error: SignupBioError | null) => {
    if (!error) return "";

    switch (error) {
      case "BIO_TOO_LONG":
        return t`Bio is too long. Maximum length is 512 characters.`;
      default:
        return "";
    }
  };

  // Field blur handlers for validation
  const handleUsernameBlur = () => {
    if (usernameInput) {
      const error = validateUsername(usernameInput.value);
      setFieldErrors((prev) => ({
        ...prev,
        username: error as SignupUsernameError | null,
      }));
    }
  };

  const handleNameBlur = () => {
    if (nameInput) {
      const error = validateDisplayName(nameInput.value);
      setFieldErrors((prev) => ({
        ...prev,
        name: error as SignupDisplayNameError | null,
      }));
    }
  };

  createEffect(() => {
    const token = props.params.token;
    const code = new URLSearchParams(window.location.search).get("code");

    if (!token || !code || !validateUuid(token)) {
      setInvalid(true);
      setVerifying(false);
      return;
    }

    fetchQuery<TokenVerifySignupTokenQuery>(
      createEnvironment(),
      verifySignupTokenQuery,
      { token, code },
    ).subscribe({
      next: (response) => {
        setVerifying(false);
        if (response.verifySignupToken) {
          setSignupInfo(response.verifySignupToken);
        } else {
          setInvalid(true);
        }
      },
      error: () => {
        setVerifying(false);
        setInvalid(true);
      },
    });
  });

  function onSubmit(event: SubmitEvent) {
    event.preventDefault();

    if (!signupInfo() || !usernameInput || !nameInput) return;

    const username = usernameInput.value.trim();
    const name = nameInput.value.trim();
    const bioValue = bio().trim();

    // Validate all fields before submission
    const usernameError = validateUsername(username);
    const nameError = validateDisplayName(name);
    const bioError = validateBio(bioValue);

    // Set field errors
    setFieldErrors({
      username: usernameError as SignupUsernameError | null,
      name: nameError as SignupDisplayNameError | null,
      bio: bioError as SignupBioError | null,
    });

    // Don't submit if there are validation errors
    if (usernameError || nameError || bioError) {
      return;
    }

    setSubmitting(true);

    completeSignup({
      variables: {
        token: props.params.token as Uuid,
        code: new URLSearchParams(window.location.search).get("code")!,
        input: { username, name, bio: bioValue },
      },
      async onCompleted(response) {
        setSubmitting(false);
        if (response.completeSignup) {
          // Check if it's a Session (success) or SignupValidationErrors
          if (response.completeSignup.__typename === "Session") {
            // Session created successfully, set cookie and redirect
            await fetch("/sign/session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: response.completeSignup.id }),
            });
            window.location.href = "/?filter=recommendations";
          } else if (
            response.completeSignup.__typename === "SignupValidationErrors"
          ) {
            // Handle field-specific validation errors
            const errors = response.completeSignup;
            setFieldErrors({
              username: errors.username || null,
              name: errors.name || null,
              bio: errors.bio || null,
            });
          }
        }
      },
      onError(error) {
        setSubmitting(false);
        showToast({
          title: t`Error`,
          description: t`An error occurred during signup. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  return (
    <>
      <div
        lang={i18n.locale}
        class="lg:p-8 min-h-screen flex items-center justify-center"
      >
        <div class="w-full max-w-2xl">
          <div class="flex flex-col space-y-2 text-center mb-8">
            <h1 class="text-2xl font-semibold tracking-tight">
              {t`Signing up for Hackers' Pub`}
            </h1>
            <Show when={verifying()}>
              <p class="text-sm text-muted-foreground">
                {t`Verifying your invitation…`}
              </p>
            </Show>
            <Show when={invalid()}>
              <p class="text-sm text-red-600">
                {t`The sign-up link is invalid. Please make sure you're using the correct link from the email you received.`}
              </p>
            </Show>
            <Show when={signupInfo()}>
              <p class="text-sm text-muted-foreground">
                {t`Welcome to Hackers' Pub! Please fill out the form below to complete your sign-up.`}
              </p>
            </Show>
          </div>

          <Show when={signupInfo()}>
            <form class="space-y-6" on:submit={onSubmit}>
              <div class="grid gap-4 lg:grid-cols-2">
                <div class="lg:col-span-2">
                  <TextField validationState="valid" class="gap-1">
                    <TextFieldLabel>{t`Email address`}</TextFieldLabel>
                    <TextFieldInput
                      type="email"
                      value={signupInfo()?.email || ""}
                      disabled
                      class="bg-muted"
                    />
                  </TextField>
                  <p class="text-sm text-muted-foreground mt-1">
                    {t`Your email address will be used to sign in to your account.`}
                  </p>
                </div>

                <div>
                  <TextField
                    validationState={fieldErrors().username
                      ? "invalid"
                      : "valid"}
                    class="gap-1"
                  >
                    <TextFieldLabel>{t`Username`} *</TextFieldLabel>
                    <div class="flex h-10 w-full items-center rounded-md border border-input text-sm ring-offset-background focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                      <span
                        aria-hidden="true"
                        class="pointer-events-none select-none whitespace-nowrap pl-3 pr-1 text-muted-foreground"
                      >
                        @
                      </span>
                      <TextFieldInput
                        ref={usernameInput}
                        type="text"
                        pattern="^[a-z0-9_]{1,15}$"
                        required
                        onBlur={handleUsernameBlur}
                        class="h-full w-auto flex-1 min-w-0 rounded-none border-0 bg-transparent px-0 py-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                      />
                      <Show when={signupInfo()?.inviter?.actor.handleHost}>
                        {(host) => (
                          <span
                            aria-hidden="true"
                            class="pointer-events-none select-none whitespace-nowrap pl-1 pr-3 text-muted-foreground"
                          >
                            @{host()}
                          </span>
                        )}
                      </Show>
                    </div>
                  </TextField>
                  {fieldErrors().username
                    ? (
                      <p class="text-sm text-red-600 mt-1">
                        {getUsernameErrorMessage(fieldErrors().username)}
                      </p>
                    )
                    : (
                      <p class="text-sm text-muted-foreground mt-1">
                        {t`Your username will be used to create your profile URL and your fediverse handle.`}
                      </p>
                    )}
                </div>

                <div>
                  <TextField
                    validationState={fieldErrors().name ? "invalid" : "valid"}
                    class="gap-1"
                  >
                    <TextFieldLabel>{t`Display name`} *</TextFieldLabel>
                    <TextFieldInput
                      ref={nameInput}
                      type="text"
                      required
                      onBlur={handleNameBlur}
                    />
                  </TextField>
                  {fieldErrors().name
                    ? (
                      <p class="text-sm text-red-600 mt-1">
                        {getDisplayNameErrorMessage(fieldErrors().name)}
                      </p>
                    )
                    : (
                      <p class="text-sm text-muted-foreground mt-1">
                        {t`Your name will be displayed on your profile and in your posts.`}
                      </p>
                    )}
                </div>

                <div class="lg:col-span-2">
                  <TextField
                    validationState={fieldErrors().bio ? "invalid" : "valid"}
                    class="gap-1"
                  >
                    <TextFieldLabel>{t`Bio`}</TextFieldLabel>
                    <MarkdownEditor
                      value={bio()}
                      onInput={(v) => {
                        setBio(v);
                        const bioError = validateBio(v.trim());
                        setFieldErrors((prev) => ({
                          ...prev,
                          bio: bioError as SignupBioError | null,
                        }));
                      }}
                      placeholder={t`Tell us about yourself…`}
                      minHeight="min-h-[100px]"
                    />
                  </TextField>
                  {fieldErrors().bio
                    ? (
                      <p class="text-sm text-red-600 mt-1">
                        {getBioErrorMessage(fieldErrors().bio)}
                      </p>
                    )
                    : (
                      <p class="text-sm text-muted-foreground mt-1">
                        {t`Your bio will be displayed on your profile. You can use Markdown to format it. Maximum 512 characters.`}
                      </p>
                    )}
                </div>

                <Show when={signupInfo()?.inviter}>
                  <div class="lg:col-span-2 p-4 bg-muted rounded-lg">
                    <h3 class="font-medium mb-2">{t`You were invited by`}</h3>
                    <div class="flex items-center gap-3">
                      <Show when={signupInfo()?.inviter?.avatarUrl}>
                        <img
                          src={signupInfo()?.inviter?.avatarUrl}
                          alt=""
                          class="w-8 h-8 rounded-full"
                        />
                      </Show>
                      <div>
                        <p class="font-medium">{signupInfo()?.inviter?.name}</p>
                        <p class="text-sm text-muted-foreground">
                          {signupInfo()?.inviter?.handle}
                        </p>
                      </div>
                    </div>
                    <p class="text-sm text-muted-foreground mt-2">
                      {t`You'll automatically follow each other when you sign up.`}
                    </p>
                  </div>
                </Show>

                <div class="lg:col-span-2">
                  <div class="rounded-lg border">
                    <div class="border-b px-4 py-3">
                      <h3 class="font-medium">{t`Code of conduct`}</h3>
                    </div>
                    <div class="h-48 overflow-y-auto p-4 text-sm prose prose-sm dark:prose-invert max-w-none">
                      <Show
                        keyed
                        when={codeOfConductData()?.codeOfConduct}
                        fallback={
                          <p class="text-muted-foreground">{t`Loading…`}</p>
                        }
                      >
                        {(doc) => (
                          <DocumentView $document={doc} showToc={false} />
                        )}
                      </Show>
                    </div>
                    <div class="border-t px-4 py-3">
                      <label class="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          class="accent-primary size-4 cursor-pointer"
                          checked={agreedToCoC()}
                          onChange={(e) =>
                            setAgreedToCoC(e.currentTarget.checked)}
                        />
                        {t`I have read and agree to the Code of conduct.`}
                      </label>
                    </div>
                  </div>
                </div>

                <div class="lg:col-span-2 text-center">
                  <Button
                    type="submit"
                    disabled={submitting() || !signupInfo() || !agreedToCoC()}
                    class="w-full cursor-pointer"
                  >
                    {submitting() ? t`Creating account…` : t`Sign up`}
                  </Button>
                </div>
              </div>
            </form>
          </Show>
        </div>
      </div>
    </>
  );
}
