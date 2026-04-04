import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { LocaleSelect } from "~/components/LocaleSelect.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import { Trans } from "~/components/Trans.tsx";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { Label } from "~/components/ui/label.tsx";
import {
  TextField,
  TextFieldErrorMessage,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import type { IdInvitationLinkPageQuery } from "./__generated__/IdInvitationLinkPageQuery.graphql.ts";
import type { IdRedeemInvitationLinkMutation } from "./__generated__/IdRedeemInvitationLinkMutation.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload(args) {
    void loadInvitationLinkPageQuery(args.params.id!, args.params.handle!);
  },
} satisfies RouteDefinition;

const invitationLinkPageQuery = graphql`
  query IdInvitationLinkPageQuery($id: UUID!, $username: String!) {
    invitationLink(id: $id, username: $username) {
      id
      uuid
      invitationsLeft
      message
      created
      expires
      inviter {
        id
        name
        username
        avatarUrl
        actor {
          handle
        }
      }
    }
    ...LocaleSelect_availableLocales
  }
`;

type UUID = `${string}-${string}-${string}-${string}-${string}`;

const loadInvitationLinkPageQuery = query(
  (id: string, handle: string) =>
    loadQuery<IdInvitationLinkPageQuery>(
      useRelayEnvironment()(),
      invitationLinkPageQuery,
      { id: id as UUID, username: handle.replace(/^@/, "") },
    ),
  "loadInvitationLinkPageQuery",
);

const invitationLinkRedeemMutation = graphql`
  mutation IdRedeemInvitationLinkMutation(
    $id: UUID!,
    $email: Email!,
    $locale: Locale!,
    $verifyUrl: URITemplate!
  ) {
    redeemInvitationLink(
      id: $id,
      email: $email,
      locale: $locale,
      verifyUrl: $verifyUrl
    ) {
      __typename
      ... on RedeemInvitationLinkSuccess {
        confirmedEmail: email
      }
      ... on RedeemInvitationLinkValidationErrors {
        link
        emailError: email
        verifyUrl
        emailOwner {
          name
          username
          actor {
            handle
          }
        }
        sendFailed
      }
    }
  }
`;

export default function InvitationLinkPage() {
  const params = useParams();
  const { t, i18n } = useLingui();
  const data = createPreloadedQuery<IdInvitationLinkPageQuery>(
    invitationLinkPageQuery,
    () => loadInvitationLinkPageQuery(params.id!, params.handle!),
  );
  const [email, setEmail] = createSignal("");
  const [locale, setLocale] = createSignal(i18n.locale);
  const [submitting, setSubmitting] = createSignal(false);
  const [success, setSuccess] = createSignal(false);
  const [emailError, setEmailError] = createSignal<string | null>(null);
  const [linkError, setLinkError] = createSignal<string | null>(null);

  const [redeemLink] = createMutation<IdRedeemInvitationLinkMutation>(
    invitationLinkRedeemMutation,
  );

  function isExpired(): boolean {
    const link = data()?.invitationLink;
    if (!link?.expires) return false;
    return new Date(link.expires) < new Date();
  }

  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    setEmailError(null);
    setLinkError(null);
    setSubmitting(true);

    const verifyUrl = `${
      globalThis.location?.origin ?? "https://hackers.pub"
    }/sign/up/{token}?code={code}`;

    redeemLink({
      variables: {
        id: params.id! as UUID,
        email: email(),
        locale: locale(),
        verifyUrl,
      },
      onCompleted({ redeemInvitationLink: result }) {
        setSubmitting(false);
        if (result.__typename === "RedeemInvitationLinkSuccess") {
          setSuccess(true);
        } else if (
          result.__typename === "RedeemInvitationLinkValidationErrors"
        ) {
          if (result.link === "LINK_NOT_FOUND") {
            setLinkError(t`This invitation link was not found.`);
          } else if (result.link === "LINK_EXPIRED") {
            setLinkError(t`This invitation link has expired.`);
          } else if (result.link === "LINK_EXHAUSTED") {
            setLinkError(
              t`This invitation link has no remaining invitations.`,
            );
          }

          if (result.emailError === "EMAIL_INVALID") {
            setEmailError(t`The email address is invalid.`);
          } else if (result.emailError === "EMAIL_ALREADY_TAKEN") {
            if (result.emailOwner) {
              setEmailError(
                t`This email is already associated with an existing account.`,
              );
            } else {
              setEmailError(
                t`This email is already associated with an existing account.`,
              );
            }
          }

          if (result.sendFailed) {
            showToast({
              variant: "error",
              title: t`Failed to send email`,
              description:
                t`The invitation email could not be sent. Please try again later.`,
            });
          }
        }
      },
      onError(error) {
        setSubmitting(false);
        showToast({
          variant: "error",
          title: t`Error`,
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
        <div
          lang={i18n.locale}
          class="lg:p-8 min-h-screen flex items-center justify-center"
        >
          <div class="w-full max-w-md p-4">
            <Show
              when={data().invitationLink}
              fallback={
                <>
                  <Title>{t`Not found`}</Title>
                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Not found`}</CardTitle>
                      <CardDescription>
                        {t`This invitation link does not exist or has been deleted.`}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </>
              }
            >
              {(link) => (
                <>
                  <Title>
                    {t`Invitation from ${
                      link().inviter.name ?? link().inviter.username
                    }`}
                  </Title>
                  <Show when={success()}>
                    <Card>
                      <CardHeader>
                        <CardTitle>{t`Check your email`}</CardTitle>
                        <CardDescription>
                          {t`Check your email to complete sign-up. We've sent a verification link to your email address.`}
                        </CardDescription>
                      </CardHeader>
                    </Card>
                  </Show>
                  <Show when={!success()}>
                    <Show when={isExpired()}>
                      <Card>
                        <CardHeader>
                          <CardTitle>{t`Link expired`}</CardTitle>
                          <CardDescription>
                            {t`This invitation link has expired.`}
                          </CardDescription>
                        </CardHeader>
                      </Card>
                    </Show>
                    <Show when={!isExpired() && link().invitationsLeft < 1}>
                      <Card>
                        <CardHeader>
                          <CardTitle>{t`No invitations left`}</CardTitle>
                          <CardDescription>
                            {t`This invitation link has no remaining invitations.`}
                          </CardDescription>
                        </CardHeader>
                      </Card>
                    </Show>
                    <Show when={!isExpired() && link().invitationsLeft >= 1}>
                      <Card>
                        <CardHeader>
                          <CardTitle>
                            {t`You've been invited to Hackers' Pub`}
                          </CardTitle>
                          <CardDescription>
                            {t`Enter your email address below to get started.`}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div class="flex flex-col gap-6">
                            <div class="flex items-center gap-3 p-3 bg-muted rounded-lg">
                              <Show when={link().inviter.avatarUrl}>
                                {(avatarUrl) => (
                                  <Avatar>
                                    <a
                                      href={`/@${link().inviter.username}`}
                                    >
                                      <AvatarImage src={avatarUrl()} />
                                    </a>
                                  </Avatar>
                                )}
                              </Show>
                              <div>
                                <a
                                  href={`/@${link().inviter.username}`}
                                  class="font-semibold hover:underline"
                                >
                                  {link().inviter.name}
                                </a>
                                <p class="text-sm text-muted-foreground">
                                  {link().inviter.actor.handle}
                                </p>
                              </div>
                            </div>
                            <Show when={link().message}>
                              {(message) => (
                                <div class="p-3 bg-muted rounded-lg">
                                  <p class="text-sm whitespace-pre-wrap">
                                    {message()}
                                  </p>
                                </div>
                              )}
                            </Show>
                            <div class="flex gap-4 text-sm text-muted-foreground">
                              <span>
                                {i18n._(
                                  msg`${
                                    plural(link().invitationsLeft, {
                                      one: "# invitation left",
                                      other: "# invitations left",
                                    })
                                  }`,
                                )}
                              </span>
                              <Show when={link().expires}>
                                {(expires) => (
                                  <span>
                                    <Trans
                                      message={t`Expires ${"DATE"}`}
                                      values={{
                                        DATE: () => (
                                          <Timestamp
                                            value={expires()}
                                            allowFuture
                                          />
                                        ),
                                      }}
                                    />
                                  </span>
                                )}
                              </Show>
                            </div>
                            <Show when={linkError()}>
                              {(error) => (
                                <p class="text-sm text-destructive">
                                  {error()}
                                </p>
                              )}
                            </Show>
                            <form
                              on:submit={onSubmit}
                              class="flex flex-col gap-4"
                            >
                              <TextField
                                class="grid w-full items-center gap-1.5"
                                validationState={emailError()
                                  ? "invalid"
                                  : "valid"}
                              >
                                <TextFieldLabel for="email">
                                  {t`Email address`}
                                </TextFieldLabel>
                                <TextFieldInput
                                  type="email"
                                  required
                                  id="email"
                                  placeholder="you@email.com"
                                  value={email()}
                                  onInput={(e) =>
                                    setEmail(e.currentTarget.value)}
                                />
                                <Show when={emailError()}>
                                  {(error) => (
                                    <TextFieldErrorMessage class="leading-6">
                                      {error()}
                                    </TextFieldErrorMessage>
                                  )}
                                </Show>
                              </TextField>
                              <div class="flex flex-col gap-1.5">
                                <Label>
                                  {t`Preferred language`}
                                </Label>
                                <LocaleSelect
                                  $availableLocales={data()}
                                  value={locale()}
                                  onChange={setLocale}
                                />
                                <p class="text-sm text-muted-foreground">
                                  {t`Choose your preferred language for the verification email.`}
                                </p>
                              </div>
                              <Button
                                type="submit"
                                disabled={submitting() ||
                                  email().trim() === ""}
                                class="w-full cursor-pointer"
                              >
                                {submitting() ? t`Sending…` : t`Sign up`}
                              </Button>
                            </form>
                          </div>
                        </CardContent>
                      </Card>
                    </Show>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
