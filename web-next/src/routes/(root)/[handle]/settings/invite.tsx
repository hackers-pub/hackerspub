import {
  Navigate,
  query,
  type RouteDefinition,
  useLocation,
  useParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, Match, Show, Switch } from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { LocaleSelect } from "~/components/LocaleSelect.tsx";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { Trans } from "~/components/Trans.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Label } from "~/components/ui/label.tsx";
import {
  TextField,
  TextFieldDescription,
  TextFieldErrorMessage,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import type {
  InviteEmailError,
  InviteInviterError,
  inviteMutation,
} from "./__generated__/inviteMutation.graphql.ts";
import type { invitePageQuery } from "./__generated__/invitePageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload(args) {
    void loadInvitePageQuery(args.params.handle);
  },
} satisfies RouteDefinition;

const invitePageQuery = graphql`
  query invitePageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      invitationsLeft
      ...SettingsTabs_account
      actor {
        ...ProfilePageBreadcrumb_actor
      }
    }
    ...LocaleSelect_availableLocales
  }
`;

const loadInvitePageQuery = query(
  (handle: string) =>
    loadQuery<invitePageQuery>(
      useRelayEnvironment()(),
      invitePageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadInvitePageQuery",
);

const inviteMutation = graphql`
  mutation inviteMutation(
    $email: Email!,
    $locale: Locale!,
    $message: Markdown,
    $verifyUrl: URITemplate!
  ) {
    invite(
      email: $email,
      locale: $locale,
      message: $message,
      verifyUrl: $verifyUrl,
    ) {
      __typename
      ... on Invitation {
        inviter {
          id
          invitationsLeft
        }
      }
      ... on InviteValidationErrors {
        account: inviter
        email
        verifyUrl
        emailOwner {
          name
          handle
          username
        }
      }
    }
  }
`;

export default function InvitePage() {
  const params = useParams();
  const location = useLocation();
  const { t, i18n } = useLingui();
  const data = createPreloadedQuery<invitePageQuery>(
    invitePageQuery,
    () => loadInvitePageQuery(params.handle),
  );
  const [inviterError, setInviterError] = createSignal<
    InviteInviterError | undefined
  >();
  const [email, setEmail] = createSignal("");
  const [emailError, setEmailError] = createSignal<
    InviteEmailError | undefined
  >();
  const [emailOwner, setEmailOwner] = createSignal<
    { name: string; handle: string; username: string } | undefined
  >();
  const [invitationLanguage, setInvitationLanguage] = createSignal(i18n.locale);
  const [message, setMessage] = createSignal("");
  const [send] = createMutation<inviteMutation>(inviteMutation);
  const [sending, setSending] = createSignal(false);
  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    setSending(true);
    send({
      variables: {
        email: email(),
        locale: invitationLanguage(),
        message: message().trim() === "" ? null : message().trim(),
        verifyUrl: `${
          globalThis.location?.origin ?? "https://hackers.pub"
        }/sign/up/{token}?code={code}`,
      },
      onCompleted({ invite }) {
        setSending(false);
        if (invite.__typename === "InviteValidationErrors") {
          setInviterError(invite.account ?? undefined);
          setEmailError(invite.email ?? undefined);
          setEmailOwner(invite.emailOwner ?? undefined);
          showToast({
            variant: "error",
            title: t`Failed to send invitation`,
            description: t`Please correct the errors and try again.`,
          });
        } else {
          setInviterError(undefined);
          setEmailError(undefined);
          setEmailOwner(undefined);
          setEmail("");
          setMessage("");
          showToast({
            title: t`Invitation sent`,
            description: t`The invitation has been sent successfully.`,
          });
        }
      },
      onError(error) {
        console.error(error);
        setSending(false);
        showToast({
          variant: "error",
          title: t`Failed to send invitation`,
          description:
            t`An unexpected error occurred. Please try again later.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
        });
      },
    });
  }

  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show
            when={data().viewer}
            fallback={
              <Navigate
                href={`/sign?next=${encodeURIComponent(location.pathname)}`}
              />
            }
          >
            {(viewer) => (
              <Show when={data().accountByUsername}>
                {(account) => (
                  <Show when={viewer().id !== account().id}>
                    <Navigate href="/" />
                  </Show>
                )}
              </Show>
            )}
          </Show>
          <Show when={data().accountByUsername}>
            {(account) => (
              <>
                <Title>{t`Invite`}</Title>
                <ProfilePageBreadcrumb $actor={account().actor}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink href={`/@${account().username}/settings`}>
                      {t`Settings`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink current>
                      {t`Invite`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div class="p-4">
                  <div class="mx-auto max-w-prose">
                    <SettingsTabs
                      selected="invite"
                      $account={account()}
                    />
                    <form on:submit={onSubmit} class="flex flex-col gap-4 mt-4">
                      <p class="text-sm text-muted-foreground">
                        <Show
                          when={account().invitationsLeft > 0}
                          fallback={t`You have no invitations left. Please wait until you receive more.`}
                        >
                          {i18n._(msg`${
                            plural(account().invitationsLeft, {
                              one:
                                "Invite your friends to Hackers' Pub. You can invite up to # person.",
                              other:
                                "Invite your friends to Hackers' Pub. You can invite up to # people.",
                            })
                          }`)}
                        </Show>
                      </p>
                      <TextField
                        class="grid w-full items-center gap-1.5"
                        validationState={emailError() == null
                          ? "valid"
                          : "invalid"}
                      >
                        <TextFieldLabel for="email">
                          {t`Email address`}
                        </TextFieldLabel>
                        <TextFieldInput
                          type="email"
                          required
                          id="email"
                          placeholder="yourfriend@email.com"
                          value={email()}
                          onInput={(e) => setEmail(e.currentTarget.value)}
                        />
                        <Switch>
                          <Match when={emailError() == null}>
                            <TextFieldDescription class="leading-6">
                              {t`The email address is not only used for receiving the invitation, but also for signing in to the account.`}
                            </TextFieldDescription>
                          </Match>
                          <Match when={emailError() === "EMAIL_INVALID"}>
                            <TextFieldErrorMessage class="leading-6">
                              {t`The email address is invalid.`}
                            </TextFieldErrorMessage>
                          </Match>
                          <Match
                            when={emailError() === "EMAIL_ALREADY_TAKEN" &&
                              emailOwner() != null}
                          >
                            <TextFieldErrorMessage class="leading-6">
                              <Trans
                                message={t`${"USER"} is already a member of Hackers' Pub.`}
                                values={{
                                  USER: () => (
                                    <a href={`/@${emailOwner()?.username}`}>
                                      <strong>{emailOwner()?.name}</strong>{" "}
                                      <span class="opacity-75">
                                        ({emailOwner()?.handle})
                                      </span>
                                    </a>
                                  ),
                                }}
                              />
                            </TextFieldErrorMessage>
                          </Match>
                        </Switch>
                      </TextField>
                      <div class="flex flex-col gap-1.5">
                        <Label>{t`Invitation language`}</Label>
                        <LocaleSelect
                          $availableLocales={data()}
                          value={invitationLanguage()}
                          onChange={setInvitationLanguage}
                        />
                        <p class="text-sm text-muted-foreground">
                          {t`Choose the language your friend prefers. This language will only be used for the invitation.`}
                        </p>
                      </div>
                      <TextField class="grid w-full items-center gap-1.5">
                        <TextFieldLabel for="message">
                          {t`Extra message`}
                        </TextFieldLabel>
                        <TextFieldTextArea
                          id="message"
                          value={message()}
                          onInput={(e) => setMessage(e.currentTarget.value)}
                          placeholder={t`You can leave this field empty.`}
                        />
                        <TextFieldDescription class="leading-6">
                          {t`Your friend will see this message in the invitation email.`}
                        </TextFieldDescription>
                      </TextField>
                      <Button
                        type="submit"
                        class="cursor-pointer"
                        disabled={sending() || account().invitationsLeft <= 0}
                      >
                        {account().invitationsLeft <= 0
                          ? t`No invitations left`
                          : sending()
                          ? t`Sending…`
                          : t`Send`}
                      </Button>
                      <Show
                        when={inviterError() === "INVITER_NO_INVITATIONS_LEFT"}
                      >
                        <p class="text-sm text-destructive">
                          {t`You have no invitations left. Please wait until you receive more.`}
                        </p>
                      </Show>
                    </form>
                  </div>
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
