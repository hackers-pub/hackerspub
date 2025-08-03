import {
  validateBio,
  validateDisplayName,
  validateUsername,
} from "@hackerspub/models/userValidation";
import type { Uuid } from "@hackerspub/models/uuid";
import { validateUuid } from "@hackerspub/models/uuid";
import { toaster } from "@kobalte/core";
import { type RouteSectionProps, useNavigate } from "@solidjs/router";
import { fetchQuery, graphql } from "relay-runtime";
import { createEffect, createSignal, Show } from "solid-js";
import { getRequestEvent } from "solid-js/web";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { getRequestProtocol, setCookie } from "vinxi/http";
import { DocumentView } from "~/components/DocumentView.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import {
  Toast,
  ToastContent,
  ToastDescription,
  ToastList,
  ToastRegion,
  ToastTitle,
} from "~/components/ui/toast.tsx";
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

type SignupInfo = NonNullable<
  TokenVerifySignupTokenQuery["response"]["verifySignupToken"]
>;

export default function SignupPage(props: RouteSectionProps) {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const [signupInfo, setSignupInfo] = createSignal<SignupInfo | null>(null);
  const [verifying, setVerifying] = createSignal(true);
  const [invalid, setInvalid] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [fieldErrors, setFieldErrors] = createSignal({
    username: null as SignupUsernameError | null,
    name: null as SignupDisplayNameError | null,
    bio: null as SignupBioError | null,
  });

  const codeOfConductData = createPreloadedQuery<TokenCodeOfConductQuery>(
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
  let bioInput: HTMLTextAreaElement | undefined;

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

  const handleBioBlur = () => {
    if (bioInput) {
      const error = validateBio(bioInput.value);
      setFieldErrors((prev) => ({
        ...prev,
        bio: error as SignupBioError | null,
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
    const bio = bioInput?.value?.trim() || "";

    // Validate all fields before submission
    const usernameError = validateUsername(username);
    const nameError = validateDisplayName(name);
    const bioError = validateBio(bio);

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
        input: { username, name, bio },
      },
      onCompleted(response) {
        setSubmitting(false);
        if (response.completeSignup) {
          // Check if it's a Session (success) or SignupValidationErrors
          if (response.completeSignup.__typename === "Session") {
            // Session created successfully, set cookie and redirect
            setSessionCookie(response.completeSignup.id).then((success) => {
              if (success) {
                navigate("/?filter=recommendations");
              }
            });
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
        toaster.show((props) => (
          <Toast toastId={props.toastId} variant="destructive">
            <ToastContent>
              <ToastTitle>{t`Error`}</ToastTitle>
              <ToastDescription>
                {error.message ||
                  t`An error occurred during signup. Please try again.`}
              </ToastDescription>
            </ToastContent>
          </Toast>
        ));
      },
    });
  }

  return (
    <>
      <ToastRegion>
        <ToastList />
      </ToastRegion>

      <div lang={i18n.locale} class="lg:p-8">
        <div class="mx-auto max-w-2xl">
          <div class="flex flex-col space-y-2 text-center mb-8">
            <h1 class="text-2xl font-semibold tracking-tight">
              {t`Sign up`}
            </h1>
            <Show when={verifying()}>
              <p class="text-sm text-muted-foreground">
                {t`Verifying your invitation...`}
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
                    <TextFieldInput
                      ref={usernameInput}
                      type="text"
                      pattern="^[a-z0-9_]{1,15}$"
                      required
                      onBlur={handleUsernameBlur}
                    />
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
                    <TextFieldTextArea
                      ref={bioInput}
                      rows={4}
                      placeholder={t`Tell us about yourself...`}
                      onBlur={handleBioBlur}
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
                          @{signupInfo()?.inviter?.handle}
                        </p>
                      </div>
                    </div>
                    <p class="text-sm text-muted-foreground mt-2">
                      {t`You'll automatically follow each other when you sign up.`}
                    </p>
                  </div>
                </Show>

                <div class="lg:col-span-2">
                  <div class="border rounded-lg p-4">
                    <h3 class="font-medium mb-2">{t`Code of conduct`}</h3>
                    <p class="text-sm text-muted-foreground mb-3">
                      {t`I have read and agree to the Code of conduct.`}
                    </p>
                    <details class="text-sm">
                      <summary class="cursor-pointer text-blue-600 hover:text-blue-800">
                        {t`Read the full Code of conduct`}
                      </summary>
                      <div class="mt-2 p-3 bg-muted rounded prose prose-sm max-w-none">
                        <Show
                          when={codeOfConductData()?.codeOfConduct}
                          fallback={
                            <p class="text-muted-foreground">{t`Loading...`}</p>
                          }
                        >
                          {(doc) => <DocumentView $document={doc()} />}
                        </Show>
                      </div>
                    </details>
                  </div>
                </div>

                <div class="lg:col-span-2 text-center">
                  <Button
                    type="submit"
                    disabled={submitting() || !signupInfo()}
                    class="w-full cursor-pointer"
                  >
                    {submitting() ? t`Creating account...` : t`Sign up`}
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
